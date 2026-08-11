import { Router } from "express";
import type { Response } from "express";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { namespaces, messages, files, namespaceLinearIssues } from "../db/schema.js";
import { findParticipantNamespace } from "../db/participation.js";
import { consumeUserClaimToken } from "./userClaimTokens.js";
import { createUserSessionCookie } from "./userSession.js";
import { USER_SESSION_COOKIE_NAME, requireUserSession, type UserSessionRequest } from "./userAuth.js";
import { linearIssueUrl } from "../slack/linearLinks.js";
import { resolveDisplayNames } from "../slack/userProfiles.js";
import { extractMentionedUserIds } from "../slack/mentions.js";
import { getSignedDownloadUrl } from "../storage/bucket.js";

const SESSION_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 7; // 7 days — matches the admin session's default

// All id columns are Postgres `uuid`. Passing a non-UUID string straight into eq(...) makes
// Postgres raise 22P02 ("invalid input syntax for type uuid"), which is unhandled and would
// otherwise surface as an Express 500 (leaking a stack trace / failed SQL in non-production).
// Guard with a shape check so a malformed id is treated the same as a well-formed-but-missing
// one. This is a fresh local copy, not an import from src/dashboard/api.ts — it's an
// input-shape guard, not the authorization boundary, so duplicating a static regex carries no
// drift risk (see docs/superpowers/specs/2026-08-07-personal-view-design.md).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createMeApiRouter(db: Database, userSessionSecret: string): Router {
  const router = Router();
  const auth = requireUserSession(userSessionSecret);

  router.post("/claim", async (req, res) => {
    const token = typeof req.body?.token === "string" ? req.body.token : undefined;
    if (!token) {
      res.status(400).json({ error: "missing_token" });
      return;
    }

    const result = await consumeUserClaimToken(db, token);
    if (!result) {
      res.status(400).json({ error: "invalid_or_expired_token" });
      return;
    }

    res.cookie(
      USER_SESSION_COOKIE_NAME,
      createUserSessionCookie(result.workspaceId, result.slackUserId, userSessionSecret, SESSION_MAX_AGE_MS),
      {
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        maxAge: SESSION_MAX_AGE_MS,
        path: "/",
      },
    );
    res.status(200).json({ ok: true });
  });

  router.post("/logout", auth, (_req, res: Response) => {
    res.clearCookie(USER_SESSION_COOKIE_NAME, { path: "/" });
    res.status(200).json({ ok: true });
  });

  router.get("/me", auth, async (req: UserSessionRequest, res: Response) => {
    const profiles = await resolveDisplayNames(db, req.workspaceId!, [req.slackUserId!]);
    const profile = profiles.get(req.slackUserId!);
    res.json({ slackUserId: req.slackUserId!, displayName: profile?.displayName ?? null });
  });

  router.get("/namespaces", auth, async (req: UserSessionRequest, res: Response) => {
    // The join *is* the authorization boundary — every returned row already satisfies the
    // participation condition by construction, so no separate per-row check is needed.
    const participantRows = await db
      .selectDistinct({ namespaceId: messages.namespaceId })
      .from(messages)
      .innerJoin(namespaces, eq(messages.namespaceId, namespaces.id))
      .where(and(eq(namespaces.workspaceId, req.workspaceId!), eq(messages.slackUserId, req.slackUserId!)));

    const namespaceIds = participantRows.map((r) => r.namespaceId);
    const rows =
      namespaceIds.length > 0
        ? await db.select().from(namespaces).where(inArray(namespaces.id, namespaceIds)).orderBy(desc(namespaces.createdAt))
        : [];

    res.json(
      rows.map((n) => ({
        id: n.id,
        channelId: n.channelId,
        threadTs: n.threadTs,
        label: n.label,
        status: n.status,
        createdAt: n.createdAt,
      })),
    );
  });

  router.get("/namespaces/:id/messages", auth, async (req: UserSessionRequest, res: Response) => {
    const namespaceId = String(req.params.id);
    if (!UUID_RE.test(namespaceId)) {
      res.status(404).json({ error: "namespace_not_found" });
      return;
    }

    // A namespace outside the caller's workspace and a namespace inside their workspace they
    // never participated in both resolve to null here, and both become the identical 404 — on
    // purpose, per this codebase's core convention: never leak existence, never distinguish
    // "not yours" from "doesn't exist."
    const namespace = await findParticipantNamespace(db, req.workspaceId!, req.slackUserId!, namespaceId);
    if (!namespace) {
      res.status(404).json({ error: "namespace_not_found" });
      return;
    }

    const messageRows = await db.select().from(messages).where(eq(messages.namespaceId, namespace.id)).orderBy(messages.slackTs);

    const messageIds = messageRows.map((m) => m.id);
    const fileRows = messageIds.length > 0 ? await db.select().from(files).where(inArray(files.messageId, messageIds)) : [];
    const filesByMessageId = new Map<string, typeof fileRows>();
    for (const f of fileRows) {
      const list = filesByMessageId.get(f.messageId) ?? [];
      list.push(f);
      filesByMessageId.set(f.messageId, list);
    }

    const issueRows = await db.select().from(namespaceLinearIssues).where(eq(namespaceLinearIssues.namespaceId, namespace.id));
    const linearIssues = issueRows.map((issue) => ({ identifier: issue.issueIdentifier, url: linearIssueUrl(issue) }));

    const slackUserIds = [
      ...new Set(messageRows.flatMap((m) => [m.slackUserId, ...extractMentionedUserIds(m.text)])),
    ];
    const profiles = await resolveDisplayNames(db, req.workspaceId!, slackUserIds);

    res.json({
      messages: messageRows.map((m) => {
        const profile = profiles.get(m.slackUserId);
        return {
          id: m.id,
          slackUserId: m.slackUserId,
          displayName: profile?.displayName ?? null,
          avatarUrl: profile?.avatarUrl ?? null,
          text: m.text,
          slackTs: m.slackTs,
          walrusBlobId: m.walrusBlobId,
          walrusStorageStatus: m.walrusStorageStatus,
          walrusStoredAt: m.walrusStoredAt,
          createdAt: m.createdAt,
          files: (filesByMessageId.get(m.id) ?? []).map((f) => ({
            id: f.id,
            originalName: f.originalName,
            mimeType: f.mimeType,
            status: f.status,
          })),
        };
      }),
      linearIssues,
      mentionNames: Object.fromEntries([...profiles].map(([id, p]) => [id, p.displayName])),
    });
  });

  // Mints a fresh signed download URL on every request rather than embedding one in the
  // /namespaces/:id/messages payload above, so a dashboard tab left open past the signed URL's
  // expiry still works on click — mirrors the admin-view equivalent in api.ts, but scoped via
  // findParticipantNamespace (participation, not just workspace membership) like every other
  // personal-view route.
  router.get("/files/:id", auth, async (req: UserSessionRequest, res: Response) => {
    const fileId = String(req.params.id);
    if (!UUID_RE.test(fileId)) {
      res.status(404).json({ error: "file_not_found" });
      return;
    }

    const [row] = await db
      .select({ file: files, namespaceId: messages.namespaceId })
      .from(files)
      .innerJoin(messages, eq(files.messageId, messages.id))
      .where(eq(files.id, fileId));
    if (!row) {
      res.status(404).json({ error: "file_not_found" });
      return;
    }

    const namespace = await findParticipantNamespace(db, req.workspaceId!, req.slackUserId!, row.namespaceId);
    if (!namespace || row.file.status !== "stored" || !row.file.bucketKey) {
      res.status(404).json({ error: "file_not_found" });
      return;
    }

    const url = await getSignedDownloadUrl(row.file.bucketKey);
    res.redirect(302, url);
  });

  return router;
}
