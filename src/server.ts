import "dotenv/config";
import express from "express";
import type { Express } from "express";
import type { Database } from "./db/client.js";
import { db } from "./db/client.js";
import { createSlackReceiver, createSlackApp } from "./slack/receiver.js";
import { registerEventHandlers } from "./slack/events.js";
import { registerRecallKeyCommand } from "./slack/recallKeyCommand.js";
import { mountMcpServer } from "./mcp/server.js";

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

  const receiver = createSlackReceiver({
    db: database,
    app,
    signingSecret: requireEnv("SLACK_SIGNING_SECRET"),
    clientId: requireEnv("SLACK_CLIENT_ID"),
    clientSecret: requireEnv("SLACK_CLIENT_SECRET"),
    stateSecret: requireEnv("SLACK_STATE_SECRET"),
  });
  const slackApp = createSlackApp(receiver);
  registerEventHandlers(slackApp, database);
  registerRecallKeyCommand(slackApp, database);

  app.use(express.json());
  mountMcpServer(app, database);

  return app;
}

const isMain = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const app = buildApp(db);
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => {
    console.log(`recall-bot listening on port ${port}`);
  });
}
