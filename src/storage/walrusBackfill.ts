import { asc, eq, isNull } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { messages, namespaces } from "../db/schema.js";
import { persistMessageToWalrus, type WalrusStorageStatus } from "./walrusMemory.js";

export interface WalrusBackfillResult {
  scanned: number;
  stored: number;
  pending: number;
  failed: number;
}

export async function backfillWalrusMessages(params: {
  db: Database;
  limit?: number;
}): Promise<WalrusBackfillResult> {
  const { db, limit = 100 } = params;
  const rows = await db
    .select({ message: messages, namespace: namespaces })
    .from(messages)
    .innerJoin(namespaces, eq(messages.namespaceId, namespaces.id))
    .where(isNull(messages.walrusBlobId))
    .orderBy(asc(messages.createdAt))
    .limit(limit);

  const result: WalrusBackfillResult = { scanned: rows.length, stored: 0, pending: 0, failed: 0 };

  for (const row of rows) {
    const publishResult = await persistMessageToWalrus({
      db,
      messageId: row.message.id,
      workspaceId: row.namespace.workspaceId,
      namespaceId: row.namespace.id,
      channelId: row.namespace.channelId,
      threadTs: row.namespace.threadTs,
      slackUserId: row.message.slackUserId,
      slackTs: row.message.slackTs,
      text: row.message.text,
      createdAt: row.message.createdAt,
    });
    result[publishResult.status as WalrusStorageStatus] += 1;
  }

  return result;
}
