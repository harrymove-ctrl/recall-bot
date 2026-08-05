import { and, eq } from "drizzle-orm";
import type { App } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import type { Database } from "../db/client.js";
import { namespaces, messages } from "../db/schema.js";
import { backfillThread } from "./backfill.js";
import { captureSlackFile, type SlackFileObject } from "./files.js";

interface AppMentionLikeEvent {
  channel: string;
  ts: string;
  thread_ts?: string;
  user?: string;
  text: string;
}

export async function handleAppMention(params: {
  db: Database;
  client: WebClient;
  botToken: string;
  workspaceId: string;
  event: AppMentionLikeEvent;
}): Promise<void> {
  const { db, client, botToken, workspaceId, event } = params;
  const threadTs = event.thread_ts ?? event.ts;

  await backfillThread({
    db,
    client,
    workspaceId,
    channelId: event.channel,
    threadTs,
    botToken,
  });

  await db
    .update(namespaces)
    .set({ status: "active", updatedAt: new Date() })
    .where(and(eq(namespaces.workspaceId, workspaceId), eq(namespaces.channelId, event.channel), eq(namespaces.threadTs, threadTs)));
}

interface MessageLikeEvent {
  channel: string;
  ts: string;
  thread_ts?: string;
  user?: string;
  text?: string;
  files?: SlackFileObject[];
}

export async function handleMessage(params: {
  db: Database;
  botToken: string;
  workspaceId: string;
  message: MessageLikeEvent;
}): Promise<void> {
  const { db, botToken, workspaceId, message } = params;

  if (!message.thread_ts || !message.user) return; // not a thread reply, or a subtype we don't track

  const [namespace] = await db
    .select()
    .from(namespaces)
    .where(
      and(
        eq(namespaces.workspaceId, workspaceId),
        eq(namespaces.channelId, message.channel),
        eq(namespaces.threadTs, message.thread_ts),
        eq(namespaces.status, "active"),
      ),
    );
  if (!namespace) return; // not a thread we're watching

  const [messageRow] = await db
    .insert(messages)
    .values({
      namespaceId: namespace.id,
      slackUserId: message.user,
      text: message.text ?? "",
      slackTs: message.ts,
    })
    .onConflictDoNothing({ target: [messages.namespaceId, messages.slackTs] })
    .returning();

  if (messageRow && message.files?.length) {
    for (const file of message.files) {
      await captureSlackFile({ db, file, botToken, messageId: messageRow.id });
    }
  }
}

export function registerEventHandlers(app: App, db: Database): void {
  app.event("app_mention", async ({ event, client, context }) => {
    const teamId = context.teamId as string | undefined;
    if (!teamId) return;
    const workspace = await db.query.workspaces.findFirst({
      where: (w, { eq: eqCol }) => eqCol(w.slackTeamId, teamId),
    });
    if (!workspace) return;

    await handleAppMention({
      db,
      client,
      botToken: context.botToken as string,
      workspaceId: workspace.id,
      event,
    });
  });

  app.message(async ({ message, context }) => {
    const teamId = context.teamId as string | undefined;
    if (!teamId || message.subtype !== undefined) return;
    const workspace = await db.query.workspaces.findFirst({
      where: (w, { eq: eqCol }) => eqCol(w.slackTeamId, teamId),
    });
    if (!workspace) return;

    await handleMessage({
      db,
      botToken: context.botToken as string,
      workspaceId: workspace.id,
      message: message as unknown as MessageLikeEvent,
    });
  });
}
