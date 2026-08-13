import { eq } from "drizzle-orm";
import { files, messages } from "../db/schema.js";
function publisherUrl() {
    const value = process.env.WALRUS_PUBLISHER_URL?.trim();
    return value && value.length > 0 ? value : null;
}
function buildPublisherBlobUrl(baseUrl) {
    const trimmed = baseUrl.replace(/\/+$/, "");
    if (trimmed.endsWith("/v1/blobs"))
        return withWalrusQuery(trimmed);
    return withWalrusQuery(`${trimmed}/v1/blobs`);
}
function withWalrusQuery(url) {
    const params = new URLSearchParams();
    const epochs = process.env.WALRUS_EPOCHS?.trim();
    const permanent = process.env.WALRUS_PERMANENT?.trim();
    const deletable = process.env.WALRUS_DELETABLE?.trim();
    const sendObjectTo = process.env.WALRUS_SEND_OBJECT_TO?.trim();
    if (epochs)
        params.set("epochs", epochs);
    if (permanent)
        params.set("permanent", permanent);
    if (deletable)
        params.set("deletable", deletable);
    if (sendObjectTo)
        params.set("send_object_to", sendObjectTo);
    const query = params.toString();
    return query ? `${url}?${query}` : url;
}
function stringValue(value) {
    if (typeof value === "string" && value.length > 0)
        return value;
    if (typeof value === "number" && Number.isFinite(value))
        return String(value);
    return null;
}
function extractPublishResult(body) {
    if (!body || typeof body !== "object") {
        return { blobId: null, blobObjectId: null, txDigest: null, endEpoch: null };
    }
    const record = body;
    const newlyCreated = record.newlyCreated;
    const alreadyCertified = record.alreadyCertified;
    const blobObject = newlyCreated?.blobObject;
    const storage = blobObject?.storage;
    const event = alreadyCertified?.event;
    return {
        blobId: stringValue(blobObject?.blobId) ??
            stringValue(alreadyCertified?.blobId) ??
            stringValue(record.blobId) ??
            stringValue(record.blob_id) ??
            stringValue(record.id),
        blobObjectId: stringValue(blobObject?.id) ?? null,
        txDigest: stringValue(event?.txDigest) ?? stringValue(record.txDigest) ?? null,
        endEpoch: stringValue(storage?.endEpoch) ?? stringValue(alreadyCertified?.endEpoch) ?? null,
    };
}
export async function publishWalrusMemory(payload) {
    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    return publishWalrusBlob(bytes, "application/json");
}
export async function publishWalrusBlob(blobBody, contentType) {
    const url = publisherUrl();
    if (!url)
        return { status: "pending", blobId: null, blobObjectId: null, txDigest: null, endEpoch: null };
    const response = await fetch(buildPublisherBlobUrl(url), {
        method: "PUT",
        headers: { "content-type": contentType },
        body: blobBody,
    });
    if (!response.ok) {
        throw new Error(`Walrus publisher failed with ${response.status} ${response.statusText}`);
    }
    const responseBody = (await response.json());
    const result = extractPublishResult(responseBody);
    if (!result.blobId) {
        throw new Error("Walrus publisher response did not include a blobId");
    }
    return { status: "stored", ...result };
}
export async function persistMessageToWalrus(params) {
    const { db, messageId, workspaceId, namespaceId, channelId, threadTs, slackUserId, slackTs, text, createdAt } = params;
    try {
        const result = await publishWalrusMemory({
            version: 1,
            workspaceId,
            namespaceId,
            slack: {
                channelId,
                threadTs,
                messageTs: slackTs,
                userId: slackUserId,
            },
            content: { text },
            createdAt: createdAt.toISOString(),
        });
        await db
            .update(messages)
            .set({
            walrusBlobId: result.blobId,
            walrusBlobObjectId: result.blobObjectId,
            walrusTxDigest: result.txDigest,
            walrusEndEpoch: result.endEpoch,
            walrusStorageStatus: result.status,
            walrusStoredAt: result.status === "stored" ? new Date() : null,
        })
            .where(eq(messages.id, messageId));
        return result;
    }
    catch (error) {
        console.error(`persistMessageToWalrus: failed for message ${messageId}:`, error);
        await db
            .update(messages)
            .set({ walrusStorageStatus: "failed", walrusStoredAt: null })
            .where(eq(messages.id, messageId));
        return { status: "failed", blobId: null, blobObjectId: null, txDigest: null, endEpoch: null };
    }
}
export async function persistFileToWalrus(params) {
    const { db, fileId, bytes, mimeType } = params;
    try {
        const result = await publishWalrusBlob(bytes, mimeType);
        await db
            .update(files)
            .set({
            walrusBlobId: result.blobId,
            walrusBlobObjectId: result.blobObjectId,
            walrusTxDigest: result.txDigest,
            walrusEndEpoch: result.endEpoch,
            walrusStorageStatus: result.status,
            walrusStoredAt: result.status === "stored" ? new Date() : null,
        })
            .where(eq(files.id, fileId));
        return result;
    }
    catch (error) {
        console.error(`persistFileToWalrus: failed for file ${fileId}:`, error);
        await db.update(files).set({ walrusStorageStatus: "failed", walrusStoredAt: null }).where(eq(files.id, fileId));
        return { status: "failed", blobId: null, blobObjectId: null, txDigest: null, endEpoch: null };
    }
}
export async function readWalrusBlob(blobId) {
    const baseUrl = process.env.WALRUS_AGGREGATOR_URL?.trim();
    if (!baseUrl)
        return null;
    const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/v1/blobs/${encodeURIComponent(blobId)}`);
    if (!response.ok) {
        throw new Error(`Walrus aggregator failed with ${response.status} ${response.statusText}`);
    }
    return new Uint8Array(await response.arrayBuffer());
}
//# sourceMappingURL=walrusMemory.js.map