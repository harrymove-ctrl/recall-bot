import { describe, expect, it, vi, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/client.js";
import { files, messages, namespaces, workspaces } from "../../src/db/schema.js";
import { backfillWalrusFiles, backfillWalrusMessages } from "../../src/storage/walrusBackfill.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("backfillWalrusMessages", () => {
  it("publishes existing messages without Walrus blob IDs", async () => {
    const [workspace] = await db.insert(workspaces).values({ slackTeamId: "T-BACKFILL", name: "Backfill" }).returning();
    const [namespace] = await db
      .insert(namespaces)
      .values({ workspaceId: workspace.id, channelId: "C1", threadTs: "1.0" })
      .returning();
    const [missing] = await db
      .insert(messages)
      .values({ namespaceId: namespace.id, slackUserId: "U1", text: "needs walrus", slackTs: "1.0" })
      .returning();
    await db
      .insert(messages)
      .values({ namespaceId: namespace.id, slackUserId: "U1", text: "already stored", slackTs: "1.1", walrusBlobId: "blob-old", walrusStorageStatus: "stored" });

    vi.stubEnv("WALRUS_PUBLISHER_URL", "https://walrus.example/publish");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ newlyCreated: { blobObject: { blobId: "blob-new" } } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await backfillWalrusMessages({ db, limit: 10 });

    const [row] = await db.select().from(messages).where(eq(messages.id, missing.id));
    expect(result).toEqual({ scanned: 1, stored: 1, pending: 0, failed: 0 });
    expect(row.walrusBlobId).toBe("blob-new");
    expect(row.walrusStorageStatus).toBe("stored");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("leaves rows pending when the publisher is not configured", async () => {
    const [workspace] = await db.insert(workspaces).values({ slackTeamId: "T-BACKFILL-PENDING", name: "Backfill" }).returning();
    const [namespace] = await db
      .insert(namespaces)
      .values({ workspaceId: workspace.id, channelId: "C1", threadTs: "1.0" })
      .returning();
    await db
      .insert(messages)
      .values({ namespaceId: namespace.id, slackUserId: "U1", text: "needs walrus", slackTs: "1.0" })
      .returning();

    const result = await backfillWalrusMessages({ db, limit: 10 });

    expect(result).toEqual({ scanned: 1, stored: 0, pending: 1, failed: 0 });
  });

  it("publishes stored files without Walrus blob IDs", async () => {
    const [workspace] = await db.insert(workspaces).values({ slackTeamId: "T-BACKFILL-FILE", name: "Backfill" }).returning();
    const [namespace] = await db
      .insert(namespaces)
      .values({ workspaceId: workspace.id, channelId: "C1", threadTs: "1.0" })
      .returning();
    const [message] = await db
      .insert(messages)
      .values({ namespaceId: namespace.id, slackUserId: "U1", text: "has file", slackTs: "1.0" })
      .returning();
    const [file] = await db
      .insert(files)
      .values({ messageId: message.id, bucketKey: "messages/file.txt", originalName: "file.txt", mimeType: "text/plain", status: "stored" })
      .returning();

    vi.stubEnv("BUCKET", "test-bucket");
    vi.stubEnv("ACCESS_KEY_ID", "key");
    vi.stubEnv("SECRET_ACCESS_KEY", "secret");
    vi.stubEnv("WALRUS_PUBLISHER_URL", "https://walrus.example");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, arrayBuffer: async () => new TextEncoder().encode("file").buffer })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ newlyCreated: { blobObject: { blobId: "file-blob" } } }) });
    vi.stubGlobal("fetch", fetchMock);

    const result = await backfillWalrusFiles({ db, limit: 10 });

    const [row] = await db.select().from(files).where(eq(files.id, file.id));
    expect(result).toEqual({ scanned: 1, stored: 1, pending: 0, failed: 0 });
    expect(row.walrusBlobId).toBe("file-blob");
  });
});
