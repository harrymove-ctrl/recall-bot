import { and, eq } from "drizzle-orm";
import type { WebClient } from "@slack/bolt";
import type { Database } from "../db/client.js";
import { namespaces, messages } from "../db/schema.js";
import { captureSlackFile, type SlackFileObject } from "./files.js";

export interface BackfillThreadParams {
  db: Database;
  client: WebClient;
  workspaceId: string;
  channelId: string;
  threadTs: string;
  botToken: string;
  /** overridable only for tests — production keeps the exported default */
  retryDelayMs?: number;
}

const DEFAULT_RETRY_DELAY_MS = 500;
const MAX_RETRY_ATTEMPTS = 5;

// Slack rate-limits (and occasionally 5xxs) conversations.replies. Retrying with
// backoff here is what makes backfill resilient to that without losing progress:
// messages are upserted per-page as we go, so even if retries are exhausted partway
// through pagination, everything fetched so far stays committed. A later re-invocation
// (e.g. Slack redelivering the app_mention event) restarts pagination from page 1, but
// onConflictDoNothing makes that a no-op for anything already stored — cheap to redo,
// not lossy.
async function withRetry<T>(fn: () => Promise<T>, retryDelayMs: number): Promise<T> {
  let attempt = 0;
  let delay = retryDelayMs;
  for (;;) {
    try {
      return await fn();
    } catch (error) {
      attempt += 1;
      if (attempt >= MAX_RETRY_ATTEMPTS) throw error;
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay *= 2;
    }
  }
}

export async function backfillThread(params: BackfillThreadParams): Promise<{ namespaceId: string }> {
  const { db, client, workspaceId, channelId, threadTs, botToken, retryDelayMs = DEFAULT_RETRY_DELAY_MS } = params;

  await db
    .insert(namespaces)
    .values({ workspaceId, channelId, threadTs })
    .onConflictDoNothing({
      target: [namespaces.workspaceId, namespaces.channelId, namespaces.threadTs],
    });

  const [namespace] = await db
    .select()
    .from(namespaces)
    .where(
      and(eq(namespaces.workspaceId, workspaceId), eq(namespaces.channelId, channelId), eq(namespaces.threadTs, threadTs)),
    );

  let cursor: string | undefined;
  do {
    const page = await withRetry(
      () =>
        client.conversations.replies({
          channel: channelId,
          ts: threadTs,
          cursor,
          limit: 200,
        }),
      retryDelayMs,
    );

    for (const raw of page.messages ?? []) {
      if (!raw.ts || !raw.user) continue;

      const [messageRow] = await db
        .insert(messages)
        .values({
          namespaceId: namespace.id,
          slackUserId: raw.user,
          text: raw.text ?? "",
          slackTs: raw.ts,
        })
        .onConflictDoNothing({ target: [messages.namespaceId, messages.slackTs] })
        .returning();

      // onConflictDoNothing returns [] on a skipped row; only capture files for newly-inserted messages
      const rawFiles = (raw as { files?: SlackFileObject[] }).files ?? [];
      if (messageRow && rawFiles.length > 0) {
        for (const file of rawFiles) {
          await captureSlackFile({ db, file, botToken, messageId: messageRow.id });
        }
      }
    }

    cursor = page.response_metadata?.next_cursor || undefined;
  } while (cursor);

  return { namespaceId: namespace.id };
}
