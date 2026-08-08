import { Router } from "express";
import type { Response } from "express";
import { and, count, desc, eq, inArray, isNotNull, max } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { installations, namespaces, users, workspaces, messages, files, namespaceLinearIssues, recallEvents } from "../db/schema.js";
import { consumeClaimToken } from "./claimTokens.js";
import { createSessionCookie } from "./session.js";
import { DASHBOARD_COOKIE_NAME, requireDashboardSession, type DashboardRequest } from "./auth.js";
import { linearIssueUrl } from "../slack/linearLinks.js";
import { resolveDisplayNames } from "../slack/userProfiles.js";
import { extractMentionedUserIds } from "../slack/mentions.js";
import { getSignedDownloadUrl } from "../storage/bucket.js";

const SESSION_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

// All id columns are Postgres `uuid`. Passing a non-UUID string straight into eq(...) makes
// Postgres raise 22P02 ("invalid input syntax for type uuid"), which is unhandled and would
// otherwise surface as an Express 500 (leaking a stack trace / failed SQL in non-production).
// Guard with a shape check so a malformed id is treated the same as a well-formed-but-missing one.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createDashboardApiRouter(db: Database, sessionSecret: string): Router {
  const router = Router();
  const auth = requireDashboardSession(sessionSecret);

  router.post("/claim", async (req, res) => {
    const token = typeof req.body?.token === "string" ? req.body.token : undefined;
    if (!token) {
      res.status(400).json({ error: "missing_token" });
      return;
    }

    const result = await consumeClaimToken(db, token);
    if (!result) {
      res.status(400).json({ error: "invalid_or_expired_token" });
      return;
    }

    res.cookie(DASHBOARD_COOKIE_NAME, createSessionCookie(result.workspaceId, sessionSecret, SESSION_MAX_AGE_MS), {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: SESSION_MAX_AGE_MS,
      path: "/",
    });
    res.status(200).json({ ok: true });
  });

  router.post("/logout", auth, (_req, res: Response) => {
    res.clearCookie(DASHBOARD_COOKIE_NAME, { path: "/" });
    res.status(200).json({ ok: true });
  });

  router.get("/me", auth, async (req: DashboardRequest, res: Response) => {
    const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, req.workspaceId!));
    if (!workspace) {
      res.status(404).json({ error: "workspace_not_found" });
      return;
    }
    const [installation] = await db.select().from(installations).where(eq(installations.workspaceId, workspace.id));
    res.json({
      name: workspace.name,
      slackTeamId: workspace.slackTeamId,
      installedAt: installation?.createdAt ?? null,
      revoked: Boolean(installation?.revokedAt),
    });
  });

  router.get("/namespaces", auth, async (req: DashboardRequest, res: Response) => {
    const rows = await db
      .select()
      .from(namespaces)
      .where(eq(namespaces.workspaceId, req.workspaceId!))
      .orderBy(desc(namespaces.createdAt));

    const namespaceIds = rows.map((n) => n.id);
    const issueRows =
      namespaceIds.length > 0
        ? await db.select().from(namespaceLinearIssues).where(inArray(namespaceLinearIssues.namespaceId, namespaceIds))
        : [];
    const issuesByNamespaceId = new Map<string, { identifier: string; url: string }[]>();
    for (const issue of issueRows) {
      const list = issuesByNamespaceId.get(issue.namespaceId) ?? [];
      list.push({ identifier: issue.issueIdentifier, url: linearIssueUrl(issue) });
      issuesByNamespaceId.set(issue.namespaceId, list);
    }

    res.json(
      rows.map((n) => ({
        id: n.id,
        channelId: n.channelId,
        threadTs: n.threadTs,
        label: n.label,
        status: n.status,
        createdAt: n.createdAt,
        linearIssues: issuesByNamespaceId.get(n.id) ?? [],
      })),
    );
  });

  router.get("/namespaces/:id/messages", auth, async (req: DashboardRequest, res: Response) => {
    const namespaceId = String(req.params.id);
    if (!UUID_RE.test(namespaceId)) {
      res.status(404).json({ error: "namespace_not_found" });
      return;
    }

    const [namespace] = await db
      .select()
      .from(namespaces)
      .where(and(eq(namespaces.id, namespaceId), eq(namespaces.workspaceId, req.workspaceId!)));
    if (!namespace) {
      res.status(404).json({ error: "namespace_not_found" });
      return;
    }

    const messageRows = await db.select().from(messages).where(eq(messages.namespaceId, namespaceId)).orderBy(messages.slackTs);

    const messageIds = messageRows.map((m) => m.id);
    const fileRows = messageIds.length > 0 ? await db.select().from(files).where(inArray(files.messageId, messageIds)) : [];
    const filesByMessageId = new Map<string, typeof fileRows>();
    for (const f of fileRows) {
      const list = filesByMessageId.get(f.messageId) ?? [];
      list.push(f);
      filesByMessageId.set(f.messageId, list);
    }

    const issueRows = await db.select().from(namespaceLinearIssues).where(eq(namespaceLinearIssues.namespaceId, namespaceId));
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
      // Every mentioned-or-authoring slackUserId resolved to a display name, so the frontend's
      // mrkdwn renderer can show "@Real Name" for <@U123> mentions instead of the raw id — not
      // just for the people who happened to post a message in this thread.
      mentionNames: Object.fromEntries([...profiles].map(([id, p]) => [id, p.displayName])),
    });
  });

  // Mints a fresh signed download URL on every request rather than embedding one in the
  // /namespaces/:id/messages payload above, so a dashboard tab left open past the signed URL's
  // expiry still works on click — see the personal-view equivalent in meApi.ts for the same reason.
  router.get("/files/:id", auth, async (req: DashboardRequest, res: Response) => {
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

    const [namespace] = await db
      .select({ id: namespaces.id })
      .from(namespaces)
      .where(and(eq(namespaces.id, row.namespaceId), eq(namespaces.workspaceId, req.workspaceId!)));
    if (!namespace || row.file.status !== "stored" || !row.file.bucketKey) {
      res.status(404).json({ error: "file_not_found" });
      return;
    }

    const url = await getSignedDownloadUrl(row.file.bucketKey);
    res.redirect(302, url);
  });

  router.patch("/namespaces/:id", auth, async (req: DashboardRequest, res: Response) => {
    const { label, status } = (req.body ?? {}) as { label?: unknown; status?: unknown };
    if (status !== undefined && status !== "archived") {
      res.status(400).json({ error: "invalid_status" });
      return;
    }

    const update: { label?: string | null; status?: "archived"; updatedAt: Date } = { updatedAt: new Date() };
    if (label !== undefined) update.label = typeof label === "string" && label.length > 0 ? label : null;
    if (status === "archived") update.status = "archived";

    // A `:id` path segment is always a single string at runtime; @types/express-serve-static-core
    // widens ParamsDictionary values to `string | string[]` to account for other route patterns
    // (e.g. repeated segments), so it must be narrowed explicitly here for drizzle's eq().
    const namespaceId = String(req.params.id);
    if (!UUID_RE.test(namespaceId)) {
      res.status(404).json({ error: "namespace_not_found" });
      return;
    }
    const [row] = await db
      .update(namespaces)
      .set(update)
      .where(and(eq(namespaces.id, namespaceId), eq(namespaces.workspaceId, req.workspaceId!)))
      .returning();

    if (!row) {
      res.status(404).json({ error: "namespace_not_found" });
      return;
    }
    res.json({ id: row.id, label: row.label, status: row.status });
  });

  router.get("/users", auth, async (req: DashboardRequest, res: Response) => {
    const rows = await db
      .select()
      .from(users)
      .where(and(eq(users.workspaceId, req.workspaceId!), isNotNull(users.delegateKeyHash)));

    const slackUserIds = rows.map((u) => u.slackUserId);
    const profiles = await resolveDisplayNames(db, req.workspaceId!, slackUserIds);

    res.json(
      rows.map((u) => {
        const profile = profiles.get(u.slackUserId);
        return {
          id: u.id,
          slackUserId: u.slackUserId,
          displayName: profile?.displayName ?? null,
          avatarUrl: profile?.avatarUrl ?? null,
          keyIssuedOrRotatedAt: u.updatedAt,
        };
      }),
    );
  });

  router.post("/users/:id/revoke-key", auth, async (req: DashboardRequest, res: Response) => {
    // The WHERE clause requires delegateKeyHash to already be non-null so that a repeat call
    // against an already-revoked (or never-issued) key matches zero rows and reports
    // revoked: false — matching on id/workspaceId alone would return a row (and report
    // revoked: true) every time, since the row itself always still exists.
    const userId = String(req.params.id);
    if (!UUID_RE.test(userId)) {
      res.json({ ok: true, revoked: false });
      return;
    }
    const [row] = await db
      .update(users)
      .set({ delegateKeyHash: null, updatedAt: new Date() })
      .where(and(eq(users.id, userId), eq(users.workspaceId, req.workspaceId!), isNotNull(users.delegateKeyHash)))
      .returning();
    res.json({ ok: true, revoked: Boolean(row) });
  });

  router.get("/analytics", auth, async (req: DashboardRequest, res: Response) => {
    const rows = await db
      .select({
        namespaceId: namespaces.id,
        label: namespaces.label,
        channelId: namespaces.channelId,
        recallCount: count(recallEvents.id),
        lastRecalledAt: max(recallEvents.createdAt),
      })
      .from(recallEvents)
      .innerJoin(namespaces, eq(recallEvents.namespaceId, namespaces.id))
      .where(eq(namespaces.workspaceId, req.workspaceId!))
      .groupBy(namespaces.id, namespaces.label, namespaces.channelId)
      .orderBy(desc(max(recallEvents.createdAt)));

    res.json(rows);
  });

  return router;
}
