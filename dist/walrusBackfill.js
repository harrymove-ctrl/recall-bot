import { and, asc, eq, isNotNull, isNull } from "drizzle-orm";
import { files, messages, namespaces } from "../db/schema.js";
import { getSignedDownloadUrl } from "./bucket.js";
import { persistFileToWalrus, persistMessageToWalrus } from "./walrusMemory.js";
export async function backfillWalrusMessages(params) {
    const { db, limit = 100 } = params;
    const rows = await db
        .select({ message: messages, namespace: namespaces })
        .from(messages)
        .innerJoin(namespaces, eq(messages.namespaceId, namespaces.id))
        .where(isNull(messages.walrusBlobId))
        .orderBy(asc(messages.createdAt))
        .limit(limit);
    const result = { scanned: rows.length, stored: 0, pending: 0, failed: 0 };
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
        result[publishResult.status] += 1;
    }
    return result;
}
export async function backfillWalrusFiles(params) {
    const { db, limit = 100 } = params;
    const rows = await db
        .select({ file: files })
        .from(files)
        .where(and(isNull(files.walrusBlobId), isNotNull(files.bucketKey), eq(files.status, "stored")))
        .orderBy(asc(files.createdAt))
        .limit(limit);
    const result = { scanned: rows.length, stored: 0, pending: 0, failed: 0 };
    for (const { file } of rows) {
        try {
            if (!file.bucketKey) {
                result.failed += 1;
                continue;
            }
            const url = await getSignedDownloadUrl(file.bucketKey);
            const response = await fetch(url);
            if (!response.ok)
                throw new Error(`bucket read failed with ${response.status} ${response.statusText}`);
            const bytes = Buffer.from(await response.arrayBuffer());
            const publishResult = await persistFileToWalrus({ db, fileId: file.id, bytes, mimeType: file.mimeType });
            result[publishResult.status] += 1;
        }
        catch (error) {
            console.error(`backfillWalrusFiles: failed for file ${file.id}:`, error);
            result.failed += 1;
        }
    }
    return result;
}
//# sourceMappingURL=walrusBackfill.js.map