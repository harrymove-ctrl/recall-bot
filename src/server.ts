import "dotenv/config";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebClient } from "@slack/web-api";
import { eq } from "drizzle-orm";
import type { Express } from "express";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Database } from "./db/client.js";
import { db } from "./db/client.js";
import { workspaces } from "./db/schema.js";
import { createSlackReceiver, createSlackApp } from "./slack/receiver.js";
import { registerEventHandlers } from "./slack/events.js";
import { registerRecallKeyCommand } from "./slack/recallKeyCommand.js";
import { mountMcpServer } from "./mcp/server.js";
import { createDashboardApiRouter } from "./dashboard/api.js";
import { createGraphApiRouter } from "./dashboard/graphApi.js";
import { createMeApiRouter } from "./dashboard/meApi.js";
import { createUserSessionCookie } from "./dashboard/userSession.js";

// Resolved from this file rather than process.cwd() so it works whether this runs from
// src/server.ts (tsx) or the compiled dist/server.js — both sit one level below the
// project root that ./drizzle lives in.
const MIGRATIONS_FOLDER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../drizzle");
const DASHBOARD_DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/dashboard-web");
const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

/**
 * Object-storage configuration is validated at boot alongside the Slack vars. The S3 client in
 * src/storage/bucket.ts falls back to empty-string credentials, so without this check a deploy
 * that is missing them starts up healthy and then silently fails every single file upload at
 * capture time — the worst possible place to discover the misconfiguration.
 */
const REQUIRED_BUCKET_ENV_VARS = ["BUCKET", "ACCESS_KEY_ID", "SECRET_ACCESS_KEY", "ENDPOINT"] as const;
const SLACK_AUTH_STATE_MAX_AGE_MS = 1000 * 60 * 10;

function signSlackAuthState(secret: string, now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ ts: now }), "utf8").toString("base64url");
  const signature = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function verifySlackAuthState(state: string | undefined, secret: string, now = Date.now()): boolean {
  if (!state) return false;
  const [payload, signature, extra] = state.split(".");
  if (!payload || !signature || extra !== undefined) return false;

  const expected = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  const signatureBytes = Buffer.from(signature);
  const expectedBytes = Buffer.from(expected);
  if (signatureBytes.length !== expectedBytes.length || !crypto.timingSafeEqual(signatureBytes, expectedBytes)) {
    return false;
  }

  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { ts?: unknown };
    return typeof parsed.ts === "number" && now - parsed.ts >= 0 && now - parsed.ts <= SLACK_AUTH_STATE_MAX_AGE_MS;
  } catch {
    return false;
  }
}

export function buildApp(database: Database): Express {
  for (const name of REQUIRED_BUCKET_ENV_VARS) requireEnv(name);

  const app = express();

  app.get("/healthz", (_req, res) => {
    res.status(200).json({ ok: true });
  });

  // ── Slack OAuth ──────────────────────────────────────────────────────
  // Personal sign-in: any workspace member can authenticate directly.
  // No claim token needed — exchanges an OAuth code for a user session cookie.

  app.get("/auth/slack", (req, res) => {
    const clientId = requireEnv("SLACK_CLIENT_ID");
    const publicBaseUrl = requireEnv("PUBLIC_BASE_URL");
    const state = signSlackAuthState(requireEnv("SLACK_STATE_SECRET"));
    const redirectUri = `${publicBaseUrl}/auth/slack/callback`;
    const url = new URL("https://slack.com/oauth/v2/authorize");
    url.searchParams.set("client_id", clientId);
    // Bot scopes — include commands and app_mentions:read (bot-only)
    url.searchParams.set("scope", [
      "app_mentions:read",
      "channels:history",
      "groups:history",
      "im:history",
      "mpim:history",
      "chat:write",
      "im:write",
      "files:read",
      "commands",
      "users:read",
    ].join(","));
    // User scopes — exclude bot-only scopes (commands, app_mentions:read)
    // openid + users.identity:read are required for users.identity{} to get team + user IDs
    url.searchParams.set("user_scope", [
      "openid",
      "users.identity:read",
      "channels:history",
      "groups:history",
      "im:history",
      "mpim:history",
      "chat:write",
      "im:write",
      "files:read",
      "users:read",
    ].join(","));
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", state);
    res.redirect(302, url.toString());
  });

  app.get("/auth/slack/callback", async (req, res) => {
    const { code, state, error } = req.query as Record<string, string>;
    const publicBaseUrl = requireEnv("PUBLIC_BASE_URL");
    const clientId = requireEnv("SLACK_CLIENT_ID");
    const clientSecret = requireEnv("SLACK_CLIENT_SECRET");
    const stateSecret = requireEnv("SLACK_STATE_SECRET");

    if (error) {
      res.redirect(`/dashboard?slack_auth_error=${encodeURIComponent(error)}`);
      return;
    }
    if (!verifySlackAuthState(state, stateSecret)) {
      res.redirect("/dashboard?slack_auth_error=invalid_state");
      return;
    }
    if (!code) {
      res.redirect("/dashboard?slack_auth_error=no_code");
      return;
    }

    try {
      const result = await new WebClient().oauth.v2.access({
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: `${publicBaseUrl}/auth/slack/callback`,
        code,
      });

      const userId = result.authed_user?.id;
      const teamId = result.team?.id;

      if (!teamId || !userId) {
        throw new Error("Missing team or user id from OAuth v2 response");
      }

      // Find workspace by teamId
      const [workspace] = await database
        .select()
        .from(workspaces)
        .where(eq(workspaces.slackTeamId, teamId));

      if (!workspace) {
        // User is authenticated with Slack but their workspace doesn't have recall-bot installed.
        // Redirect to the workspace install flow so they (or an admin) can install it first.
        res.redirect("/slack/install");
        return;
      }

      // Issue user session cookie
      const userSessionSecret = requireEnv("USER_SESSION_SECRET");
      const cookie = createUserSessionCookie(
        workspace.id,
        userId,
        userSessionSecret,
        1000 * 60 * 60 * 24 * 7,
      );
      res.cookie("recall_user_session", cookie, {
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        maxAge: 1000 * 60 * 60 * 24 * 7,
        path: "/",
      });

      res.redirect("/dashboard/me");
    } catch (err) {
      console.error("Slack OAuth callback error:", err);
      res.redirect("/dashboard?slack_auth_error=callback_failed");
    }
  });

  app.get("/", (_req, res) => {
    res.sendFile("index.html", { root: PUBLIC_DIR });
  });

  const publicBaseUrl = requireEnv("PUBLIC_BASE_URL"); // captured once, reused below

  const receiver = createSlackReceiver({
    db: database,
    app,
    signingSecret: requireEnv("SLACK_SIGNING_SECRET"),
    clientId: requireEnv("SLACK_CLIENT_ID"),
    clientSecret: requireEnv("SLACK_CLIENT_SECRET"),
    stateSecret: requireEnv("SLACK_STATE_SECRET"),
    publicBaseUrl,
  });
  const slackApp = createSlackApp(receiver);
  registerEventHandlers(slackApp, database);
  registerRecallKeyCommand(slackApp, database, publicBaseUrl);

  app.use(express.json());

  const dashboardSessionSecret = requireEnv("DASHBOARD_SESSION_SECRET");
  const userSessionSecret = requireEnv("USER_SESSION_SECRET");
  // See docs/superpowers/specs/2026-08-07-personal-view-design.md: a shared secret would let a
  // personal-session cookie's payload (a strict superset of the admin cookie's shape) verify as
  // a valid admin session too, since verifySessionCookie ignores unknown extra fields. Catching
  // this misconfiguration at boot is far cheaper than discovering it as a live privilege-
  // escalation report.
  if (userSessionSecret === dashboardSessionSecret) {
    throw new Error(
      "USER_SESSION_SECRET must not equal DASHBOARD_SESSION_SECRET — generate a second, independent secret (openssl rand -hex 32).",
    );
  }

  // These two exact-path routes are registered ahead of the express.static mount below because
  // serve-static's default directory-index handling 301-redirects a bare "/dashboard" request to
  // "/dashboard/" instead of serving index.html directly — registering first lets both the root
  // and the claim path serve the SPA shell without that redirect hop.
  //
  // sendFile is called with `{ root: DASHBOARD_DIST }` rather than a pre-joined absolute path: the
  // underlying `send` module's dotfile check walks every segment of the path it's given, and only
  // scopes that check to the part relative to `root` when `root` is passed separately. Without it,
  // a project checked out under a dot-prefixed directory (e.g. a `.worktrees/<branch>` git
  // worktree) would have the file rejected as a "dotfile" and 404 even though it exists.
  app.get("/dashboard", (_req, res) => {
    res.sendFile("index.html", { root: DASHBOARD_DIST });
  });
  app.get("/dashboard/claim", (_req, res) => {
    res.sendFile("index.html", { root: DASHBOARD_DIST });
  });
  app.get("/dashboard/namespaces/:id", (_req, res) => {
    res.sendFile("index.html", { root: DASHBOARD_DIST });
  });
  // Same reasoning as the three routes above, for the personal-view surface: registered ahead of
  // express.static so a direct hit (e.g. from the Slack DM link) serves the SPA shell instead of
  // a static-file 404.
  app.get("/dashboard/me", (_req, res) => {
    res.sendFile("index.html", { root: DASHBOARD_DIST });
  });
  app.get("/dashboard/me/claim", (_req, res) => {
    res.sendFile("index.html", { root: DASHBOARD_DIST });
  });
  app.get("/dashboard/me/namespaces/:id", (_req, res) => {
    res.sendFile("index.html", { root: DASHBOARD_DIST });
  });
  app.use("/dashboard", express.static(DASHBOARD_DIST));
  // Unknown dashboard URLs still need the SPA shell so React can render the branded 404.
  app.get(/^\/dashboard(?:\/.*)?$/, (_req, res) => {
    res.status(404).sendFile("index.html", { root: DASHBOARD_DIST });
  });
  app.use("/api/dashboard", createDashboardApiRouter(database, dashboardSessionSecret));
  app.use("/api/dashboard", createGraphApiRouter(database, dashboardSessionSecret));
  app.use("/api/me", createMeApiRouter(database, userSessionSecret));

  mountMcpServer(app, database);

  // Unknown browser page routes should still receive the dashboard SPA shell so users see the
  // branded 404 instead of Express' plain "Cannot GET ..." fallback. API/MCP paths stay JSON/auth
  // surfaces and should not be disguised as HTML pages.
  app.get(/^\/(?!api(?:\/|$)|mcp(?:\/|$)).*/, (_req, res) => {
    res.status(404).sendFile("index.html", { root: DASHBOARD_DIST });
  });

  return app;
}

const isMain = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  // Runs on Railway's internal network (unlike a local `drizzle-kit migrate`, which can't reach
  // the database's private hostname), so the deploy itself brings the schema up to date instead
  // of depending on a human remembering a separate step.
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  console.log("Migrations applied");

  const app = buildApp(db);
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => {
    console.log(`recall-bot listening on port ${port}`);
  });
}
