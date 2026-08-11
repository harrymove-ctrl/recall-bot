import { describe, expect, it, vi, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/client.js";
import { files, messages, namespaces, workspaces } from "../../src/db/schema.js";
import { persistFileToWalrus, persistMessageToWalrus, readWalrusBlob } from "../../src/storage/walrusMemory.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function seedMessage() {
  const [workspace] = await db.insert(workspaces).values({ slackTeamId: "TWALRUS", name: "Walrus" }).returning();
  const [namespace] = await db
    .insert(namespaces)
    .values({ workspaceId: workspace.id, channelId: "C1", threadTs: "1.0" })
    .returning();
  const [message] = await db
    .insert(messages)
    .values({ namespaceId: namespace.id, slackUserId: "U1", text: "remember this", slackTs: "1.0" })
    .returning();
  return { workspace, namespace, message };
}

describe("persistMessageToWalrus", () => {
  it("leaves a message pending when no Walrus publisher is configured", async () => {
    const { workspace, namespace, message } = await seedMessage();

    const result = await persistMessageToWalrus({
      db,
      messageId: message.id,
      workspaceId: workspace.id,
      namespaceId: namespace.id,
      channelId: namespace.channelId,
      threadTs: namespace.threadTs,
      slackUserId: message.slackUserId,
      slackTs: message.slackTs,
      text: message.text,
      createdAt: message.createdAt,
    });

    const [row] = await db.select().from(messages).where(eq(messages.id, message.id));
    expect(result).toEqual({ status: "pending", blobId: null, blobObjectId: null, txDigest: null, endEpoch: null });
    expect(row.walrusStorageStatus).toBe("pending");
    expect(row.walrusBlobId).toBeNull();
  });

  it("stores the returned Walrus blob ID when the publisher succeeds", async () => {
    const { workspace, namespace, message } = await seedMessage();
    vi.stubEnv("WALRUS_PUBLISHER_URL", "https://walrus.example/publish");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        newlyCreated: {
          blobObject: {
            id: "0xblob-object",
            blobId: "walrus-blob-123",
            storage: { endEpoch: 42 },
          },
        },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await persistMessageToWalrus({
      db,
      messageId: message.id,
      workspaceId: workspace.id,
      namespaceId: namespace.id,
      channelId: namespace.channelId,
      threadTs: namespace.threadTs,
      slackUserId: message.slackUserId,
      slackTs: message.slackTs,
      text: message.text,
      createdAt: message.createdAt,
    });

    const [row] = await db.select().from(messages).where(eq(messages.id, message.id));
    expect(result).toEqual({
      status: "stored",
      blobId: "walrus-blob-123",
      blobObjectId: "0xblob-object",
      txDigest: null,
      endEpoch: "42",
    });
    expect(row.walrusStorageStatus).toBe("stored");
    expect(row.walrusBlobId).toBe("walrus-blob-123");
    expect(row.walrusBlobObjectId).toBe("0xblob-object");
    expect(row.walrusEndEpoch).toBe("42");
    expect(row.walrusStoredAt).toBeInstanceOf(Date);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://walrus.example/publish/v1/blobs",
      expect.objectContaining({
        method: "PUT",
        headers: { "content-type": "application/json" },
      }),
    );
  });

  it("marks the message failed when the publisher errors", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { workspace, namespace, message } = await seedMessage();
    vi.stubEnv("WALRUS_PUBLISHER_URL", "https://walrus.example/publish");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, statusText: "Server Error" }));

    const result = await persistMessageToWalrus({
      db,
      messageId: message.id,
      workspaceId: workspace.id,
      namespaceId: namespace.id,
      channelId: namespace.channelId,
      threadTs: namespace.threadTs,
      slackUserId: message.slackUserId,
      slackTs: message.slackTs,
      text: message.text,
      createdAt: message.createdAt,
    });

    const [row] = await db.select().from(messages).where(eq(messages.id, message.id));
    expect(result).toEqual({ status: "failed", blobId: null, blobObjectId: null, txDigest: null, endEpoch: null });
    expect(row.walrusStorageStatus).toBe("failed");
    expect(row.walrusBlobId).toBeNull();
    consoleError.mockRestore();
  });

  it("stores alreadyCertified publisher responses", async () => {
    const { workspace, namespace, message } = await seedMessage();
    vi.stubEnv("WALRUS_PUBLISHER_URL", "https://walrus.example/publish");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          alreadyCertified: {
            blobId: "walrus-existing",
            event: { txDigest: "digest-1" },
            endEpoch: 99,
          },
        }),
      }),
    );

    const result = await persistMessageToWalrus({
      db,
      messageId: message.id,
      workspaceId: workspace.id,
      namespaceId: namespace.id,
      channelId: namespace.channelId,
      threadTs: namespace.threadTs,
      slackUserId: message.slackUserId,
      slackTs: message.slackTs,
      text: message.text,
      createdAt: message.createdAt,
    });

    expect(result).toEqual({
      status: "stored",
      blobId: "walrus-existing",
      blobObjectId: null,
      txDigest: "digest-1",
      endEpoch: "99",
    });
  });

  it("stores file blobs on Walrus", async () => {
    const { message } = await seedMessage();
    const [file] = await db
      .insert(files)
      .values({ messageId: message.id, originalName: "report.txt", mimeType: "text/plain", status: "stored", bucketKey: "bucket-key" })
      .returning();
    vi.stubEnv("WALRUS_PUBLISHER_URL", "https://walrus.example");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ newlyCreated: { blobObject: { blobId: "file-blob" } } }),
      }),
    );

    await persistFileToWalrus({ db, fileId: file.id, bytes: Buffer.from("file"), mimeType: "text/plain" });

    const [row] = await db.select().from(files).where(eq(files.id, file.id));
    expect(row.walrusBlobId).toBe("file-blob");
    expect(row.walrusStorageStatus).toBe("stored");
  });

  it("reads a Walrus blob through the configured aggregator", async () => {
    vi.stubEnv("WALRUS_AGGREGATOR_URL", "https://aggregator.example");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: async () => new TextEncoder().encode("hello").buffer,
      }),
    );

    const bytes = await readWalrusBlob("blob/id");

    expect(new TextDecoder().decode(bytes ?? new Uint8Array())).toBe("hello");
    expect(fetch).toHaveBeenCalledWith("https://aggregator.example/v1/blobs/blob%2Fid");
  });
});
