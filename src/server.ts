import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import type { Express } from "express";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Database } from "./db/client.js";
import { db } from "./db/client.js";
import { createSlackReceiver, createSlackApp } from "./slack/receiver.js";
import { registerEventHandlers } from "./slack/events.js";
import { registerRecallKeyCommand } from "./slack/recallKeyCommand.js";
import { mountMcpServer } from "./mcp/server.js";
import { createDashboardApiRouter } from "./dashboard/api.js";
import { createMeApiRouter } from "./dashboard/meApi.js";

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

export function buildApp(database: Database): Express {
  for (const name of REQUIRED_BUCKET_ENV_VARS) requireEnv(name);

  const app = express();

  app.get("/healthz", (_req, res) => {
    res.status(200).json({ ok: true });
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
  app.use("/api/dashboard", createDashboardApiRouter(database, dashboardSessionSecret));
  app.use("/api/me", createMeApiRouter(database, userSessionSecret));

  mountMcpServer(app, database);

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
