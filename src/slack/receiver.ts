import type { Express } from "express";
import { App, ExpressReceiver } from "@slack/bolt";
import { WebClient } from "@slack/web-api";
import { eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { workspaces } from "../db/schema.js";
import { createPostgresInstallationStore } from "./installationStore.js";
import { issueClaimToken } from "../dashboard/claimTokens.js";

export interface SlackReceiverParams {
  db: Database;
  app: Express;
  signingSecret: string;
  clientId: string;
  clientSecret: string;
  stateSecret: string;
  publicBaseUrl: string;
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

async function sendClaimLinkDm(db: Database, publicBaseUrl: string, teamId: string, botToken: string, installerUserId: string) {
  const [workspace] = await db.select().from(workspaces).where(eq(workspaces.slackTeamId, teamId));
  if (!workspace) return;

  const token = await issueClaimToken(db, workspace.id);
  const client = new WebClient(botToken);
  const dm = await client.conversations.open({ users: installerUserId });
  await client.chat.postMessage({
    channel: dm.channel!.id!,
    text: `Set up your dashboard: ${publicBaseUrl}/dashboard/claim?token=${token}`,
  });
}

export function createSlackReceiver(params: SlackReceiverParams): ExpressReceiver {
  const { db, app, signingSecret, clientId, clientSecret, stateSecret, publicBaseUrl } = params;

  return new ExpressReceiver({
    signingSecret,
    clientId,
    clientSecret,
    stateSecret,
    scopes: SCOPES,
    installationStore: createPostgresInstallationStore(db),
    installerOptions: {
      directInstall: true,
      callbackOptions: {
        successAsync: async (installation, _options, _req, res) => {
          try {
            if (!installation.isEnterpriseInstall && installation.team?.id && installation.bot?.token) {
              await sendClaimLinkDm(db, publicBaseUrl, installation.team.id, installation.bot.token, installation.user.id);
            }
          } catch (error) {
            console.error("Failed to send dashboard claim link DM:", error);
          }
          (res as import("express").Response).redirect("/dashboard");
        },
        failureAsync: async (error, _options, _req, res) => {
          console.error("Slack OAuth install failed:", error);
          (res as import("express").Response).redirect("/dashboard?install_error=1");
        },
      },
    },
    app,
  });
}

export function createSlackApp(receiver: ExpressReceiver): App {
  return new App({ receiver });
}
