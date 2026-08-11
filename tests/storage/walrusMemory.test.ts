import { describe, expect, it, vi, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/client.js";
import { messages, namespaces, workspaces } from "../../src/db/schema.js";
import { persistMessageToWalrus } from "../../src/storage/walrusMemory.js";

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
    expect(result).toEqual({ status: "pending", blobId: null });
    expect(row.walrusStorageStatus).toBe("pending");
    expect(row.walrusBlobId).toBeNull();
  });

  it("stores the returned Walrus blob ID when the publisher succeeds", async () => {
    const { workspace, namespace, message } = await seedMessage();
    vi.stubEnv("WALRUS_PUBLISHER_URL", "https://walrus.example/publish");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ blobId: "walrus-blob-123" }),
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
    expect(result).toEqual({ status: "stored", blobId: "walrus-blob-123" });
    expect(row.walrusStorageStatus).toBe("stored");
    expect(row.walrusBlobId).toBe("walrus-blob-123");
    expect(row.walrusStoredAt).toBeInstanceOf(Date);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://walrus.example/publish",
      expect.objectContaining({
        method: "POST",
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
    expect(result).toEqual({ status: "failed", blobId: null });
    expect(row.walrusStorageStatus).toBe("failed");
    expect(row.walrusBlobId).toBeNull();
    consoleError.mockRestore();
  });
});
