import { Router } from "express";
import type { Response } from "express";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { installations, namespaces, users, workspaces } from "../db/schema.js";
import { consumeClaimToken } from "./claimTokens.js";
import { createSessionCookie } from "./session.js";
import { DASHBOARD_COOKIE_NAME, requireDashboardSession, type DashboardRequest } from "./auth.js";

const SESSION_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

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
      secure: process.env.NODE_ENV === "production",
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
    res.json(rows.map((u) => ({ id: u.id, slackUserId: u.slackUserId, keyIssuedOrRotatedAt: u.updatedAt })));
  });

  router.post("/users/:id/revoke-key", auth, async (req: DashboardRequest, res: Response) => {
    // The WHERE clause requires delegateKeyHash to already be non-null so that a repeat call
    // against an already-revoked (or never-issued) key matches zero rows and reports
    // revoked: false — matching on id/workspaceId alone would return a row (and report
    // revoked: true) every time, since the row itself always still exists.
    const userId = String(req.params.id);
    const [row] = await db
      .update(users)
      .set({ delegateKeyHash: null, updatedAt: new Date() })
      .where(and(eq(users.id, userId), eq(users.workspaceId, req.workspaceId!), isNotNull(users.delegateKeyHash)))
      .returning();
    res.json({ ok: true, revoked: Boolean(row) });
  });

  return router;
}
