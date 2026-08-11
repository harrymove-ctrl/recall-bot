import { eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { messages } from "../db/schema.js";

export type WalrusStorageStatus = "pending" | "stored" | "failed";

export interface WalrusMemoryPayload {
  version: 1;
  workspaceId: string;
  namespaceId: string;
  slack: {
    channelId: string;
    threadTs: string;
    messageTs: string;
    userId: string;
  };
  content: {
    text: string;
  };
  createdAt: string;
}

export interface PublishWalrusMemoryResult {
  status: WalrusStorageStatus;
  blobId: string | null;
}

function publisherUrl(): string | null {
  const value = process.env.WALRUS_PUBLISHER_URL?.trim();
  return value && value.length > 0 ? value : null;
}

function extractBlobId(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  const value = record.blobId ?? record.blob_id ?? record.id;
  return typeof value === "string" && value.length > 0 ? value : null;
}

export async function publishWalrusMemory(payload: WalrusMemoryPayload): Promise<PublishWalrusMemoryResult> {
  const url = publisherUrl();
  if (!url) return { status: "pending", blobId: null };

  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`Walrus publisher failed with ${response.status} ${response.statusText}`);
  }

  const body = (await response.json()) as unknown;
  const blobId = extractBlobId(body);
  if (!blobId) {
    throw new Error("Walrus publisher response did not include a blobId");
  }

  return { status: "stored", blobId };
}

export async function persistMessageToWalrus(params: {
  db: Database;
  messageId: string;
  workspaceId: string;
  namespaceId: string;
  channelId: string;
  threadTs: string;
  slackUserId: string;
  slackTs: string;
  text: string;
  createdAt: Date;
}): Promise<PublishWalrusMemoryResult> {
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
        walrusStorageStatus: result.status,
        walrusStoredAt: result.status === "stored" ? new Date() : null,
      })
      .where(eq(messages.id, messageId));

    return result;
  } catch (error) {
    console.error(`persistMessageToWalrus: failed for message ${messageId}:`, error);
    await db
      .update(messages)
      .set({ walrusStorageStatus: "failed", walrusStoredAt: null })
      .where(eq(messages.id, messageId));
    return { status: "failed", blobId: null };
  }
}
