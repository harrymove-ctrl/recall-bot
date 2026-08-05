import type { Express } from "express";
import { App, ExpressReceiver } from "@slack/bolt";
import type { Database } from "../db/client.js";
import { createPostgresInstallationStore } from "./installationStore.js";

export interface SlackReceiverParams {
  db: Database;
  app: Express;
  signingSecret: string;
  clientId: string;
  clientSecret: string;
  stateSecret: string;
}

const SCOPES = [
  "app_mentions:read",
  "channels:history",
  "groups:history",
  "im:history",
  "mpim:history",
  "chat:write",
  "im:write",
  "files:read",
  "commands",
];

export function createSlackReceiver(params: SlackReceiverParams): ExpressReceiver {
  const { db, app, signingSecret, clientId, clientSecret, stateSecret } = params;

  return new ExpressReceiver({
    signingSecret,
    clientId,
    clientSecret,
    stateSecret,
    scopes: SCOPES,
    installationStore: createPostgresInstallationStore(db),
    installerOptions: {
      directInstall: true,
    },
    app,
  });
}

export function createSlackApp(receiver: ExpressReceiver): App {
  return new App({ receiver });
}
