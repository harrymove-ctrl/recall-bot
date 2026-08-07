import { and, eq } from "drizzle-orm";
import type { App } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import type { Database } from "../db/client.js";
import { namespaces, messages } from "../db/schema.js";
import { resolveWorkspaceByTeamId } from "../db/workspaces.js";
import { backfillThread } from "./backfill.js";
import { captureSlackFile, type SlackFileObject } from "./files.js";
import { recordLinearIssueLinks } from "./linearLinks.js";

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

  const { namespaceId } = await backfillThread({
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

  // The MCP `recall` tool takes a namespaceId and nothing else, so this reply is the only
  // place that id is ever surfaced — without it neither the user nor their coding agent has
  // any way to discover what to recall. Posting it in-thread keeps it next to the content.
  try {
    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: threadTs,
      text:
        `Got it — this thread is now saved. Run \`/recall-key\` in a DM with me to get your delegate key, ` +
        `then ask your agent to look up namespace \`${namespaceId}\`.`,
    });
  } catch (error) {
    // The capture itself already succeeded and is committed. Throwing here would make Slack
    // retry the whole app_mention (re-running the entire backfill) over a cosmetic failure
    // such as a missing chat:write scope, so log and move on.
    console.error(`handleAppMention: failed to post confirmation for namespace ${namespaceId}:`, error);
  }
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

  if (messageRow) {
    await recordLinearIssueLinks({ db, namespaceId: namespace.id, text: message.text ?? "" });
  }
}

/**
 * Slack tags most non-plain messages with a `subtype`, and only a couple of those are real
 * user content we want to capture:
 *
 *   - `undefined`         — an ordinary message
 *   - `file_share`        — a message whose payload is an attachment (this is how EVERY file upload arrives)
 *   - `thread_broadcast`  — a thread reply posted with "also send to channel"
 *
 * Everything else (`bot_message`, `message_changed`, `message_deleted`, `message_replied`,
 * channel joins/leaves, …) is either not a human authoring a thread reply or a mutation of a
 * message we already stored, so it is dropped. This is an allow-list on purpose: an unknown
 * future subtype is dropped rather than captured.
 */
const CAPTURABLE_MESSAGE_SUBTYPES = new Set(["file_share", "thread_broadcast"]);

export function isCapturableMessageSubtype(subtype: string | undefined): boolean {
  if (subtype === undefined) return true;
  return CAPTURABLE_MESSAGE_SUBTYPES.has(subtype);
}

export function registerEventHandlers(app: App, db: Database): void {
  app.event("app_mention", async ({ event, client, context }) => {
    const teamId = context.teamId as string | undefined;
    if (!teamId) return;
    const workspace = await resolveWorkspaceByTeamId(db, teamId);
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
    if (!teamId || !isCapturableMessageSubtype(message.subtype)) return;
    const workspace = await resolveWorkspaceByTeamId(db, teamId);
    if (!workspace) return;

    await handleMessage({
      db,
      botToken: context.botToken as string,
      workspaceId: workspace.id,
      message: message as unknown as MessageLikeEvent,
    });
  });
}
