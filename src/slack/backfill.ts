import { and, eq, inArray } from "drizzle-orm";
import type { WebClient } from "@slack/web-api";
import type { Database } from "../db/client.js";
import { namespaces, messages, files } from "../db/schema.js";
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

/**
 * Re-attempts file captures for a message that was already stored by an earlier backfill.
 *
 * captureSlackFile swallows download/upload errors and parks the row at status='failed', so a
 * transient Slack or S3 outage leaves attachments permanently stranded: the message row already
 * exists, onConflictDoNothing returns nothing on the next pass, and the old code only captured
 * files for *newly inserted* messages. Re-tagging the thread is the documented way to retry, so
 * that path has to actually retry.
 *
 * Rows already at status='stored' are left untouched (matched by original name, the only handle
 * we persist for a Slack file); the stale pending/failed rows are deleted before re-capturing so
 * repeated retries replace them instead of piling up duplicates.
 */
async function retryUnresolvedFiles(params: {
  db: Database;
  messageId: string;
  rawFiles: SlackFileObject[];
  botToken: string;
}): Promise<void> {
  const { db, messageId, rawFiles, botToken } = params;

  const existingFiles = await db.select().from(files).where(eq(files.messageId, messageId));
  const unresolved = existingFiles.filter((f) => f.status !== "stored");
  if (unresolved.length === 0) return;

  const storedNames = new Set(existingFiles.filter((f) => f.status === "stored").map((f) => f.originalName));

  await db.delete(files).where(
    inArray(
      files.id,
      unresolved.map((f) => f.id),
    ),
  );

  for (const file of rawFiles) {
    if (storedNames.has(file.name)) continue;
    await captureSlackFile({ db, file, botToken, messageId });
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

      // onConflictDoNothing returns [] on a skipped row
      const rawFiles = (raw as { files?: SlackFileObject[] }).files ?? [];
      if (rawFiles.length === 0) continue;

      if (messageRow) {
        for (const file of rawFiles) {
          await captureSlackFile({ db, file, botToken, messageId: messageRow.id });
        }
        continue;
      }

      // The message was stored by an earlier pass, but its attachments may still be parked at
      // pending/failed from a transient failure back then. Re-tagging the thread must retry them.
      const [existingMessage] = await db
        .select()
        .from(messages)
        .where(and(eq(messages.namespaceId, namespace.id), eq(messages.slackTs, raw.ts)));
      if (existingMessage) {
        await retryUnresolvedFiles({ db, messageId: existingMessage.id, rawFiles, botToken });
      }
    }

    cursor = page.response_metadata?.next_cursor || undefined;
  } while (cursor);

  return { namespaceId: namespace.id };
}
