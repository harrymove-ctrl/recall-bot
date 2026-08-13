import { and, eq, inArray } from "drizzle-orm";
import { namespaces, messages, files, messageMentions } from "../db/schema.js";
import { captureSlackFile } from "./files.js";
import { recordLinearIssueLinks } from "./linearLinks.js";
import { persistMessageToWalrus } from "../storage/walrusMemory.js";
import { extractMentionedUserIds } from "./mentions.js";
const DEFAULT_RETRY_DELAY_MS = 500;
const MAX_RETRY_ATTEMPTS = 5;
// Slack rate-limits (and occasionally 5xxs) conversations.replies. Retrying with
// backoff here is what makes backfill resilient to that without losing progress:
// messages are upserted per-page as we go, so even if retries are exhausted partway
// through pagination, everything fetched so far stays committed. A later re-invocation
// (e.g. Slack redelivering the app_mention event) restarts pagination from page 1, but
// onConflictDoNothing makes that a no-op for anything already stored — cheap to redo,
// not lossy.
async function withRetry(fn, retryDelayMs) {
    let attempt = 0;
    let delay = retryDelayMs;
    for (;;) {
        try {
            return await fn();
        }
        catch (error) {
            attempt += 1;
            if (attempt >= MAX_RETRY_ATTEMPTS)
                throw error;
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
async function retryUnresolvedFiles(params) {
    const { db, messageId, rawFiles, botToken } = params;
    const existingFiles = await db.select().from(files).where(eq(files.messageId, messageId));
    const unresolved = existingFiles.filter((f) => f.status !== "stored");
    if (unresolved.length === 0)
        return;
    const storedNames = new Set(existingFiles.filter((f) => f.status === "stored").map((f) => f.originalName));
    await db.delete(files).where(inArray(files.id, unresolved.map((f) => f.id)));
    for (const file of rawFiles) {
        if (storedNames.has(file.name))
            continue;
        await captureSlackFile({ db, file, botToken, messageId });
    }
}
export async function backfillThread(params) {
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
        .where(and(eq(namespaces.workspaceId, workspaceId), eq(namespaces.channelId, channelId), eq(namespaces.threadTs, threadTs)));
    let cursor;
    do {
        const page = await withRetry(() => client.conversations.replies({
            channel: channelId,
            ts: threadTs,
            cursor,
            limit: 200,
        }), retryDelayMs);
        for (const raw of page.messages ?? []) {
            if (!raw.ts || !raw.user)
                continue;
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
            // Store @mentions from this message — runs for newly inserted messages only
            if (messageRow && raw.text) {
                const mentionedIds = extractMentionedUserIds(raw.text);
                for (const uid of mentionedIds) {
                    await db
                        .insert(messageMentions)
                        .values({ messageId: messageRow.id, slackUserId: uid })
                        .onConflictDoNothing();
                }
            }
            // Runs unconditionally — for newly inserted AND already-existing messages — so re-tagging
            // a thread doubles as retroactive link detection for namespaces captured before this
            // feature existed. onConflictDoNothing on the join table makes this cheap and idempotent.
            await recordLinearIssueLinks({ db, namespaceId: namespace.id, text: raw.text ?? "" });
            if (messageRow) {
                await persistMessageToWalrus({
                    db,
                    messageId: messageRow.id,
                    workspaceId,
                    namespaceId: namespace.id,
                    channelId,
                    threadTs,
                    slackUserId: raw.user,
                    slackTs: raw.ts,
                    text: raw.text ?? "",
                    createdAt: messageRow.createdAt,
                });
            }
            // onConflictDoNothing returns [] on a skipped row
            const rawFiles = raw.files ?? [];
            if (rawFiles.length === 0)
                continue;
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
//# sourceMappingURL=backfill.js.map