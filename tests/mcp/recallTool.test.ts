import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { S3Client } from "@aws-sdk/client-s3";
import { db } from "../../src/db/client.js";
import { workspaces, namespaces, messages, files } from "../../src/db/schema.js";
import { recallNamespace, buildMemoryPlan, buildMemoryChecklist } from "../../src/mcp/recallTool.js";

const s3Mock = mockClient(S3Client);
beforeEach(() => s3Mock.reset());
afterEach(() => vi.unstubAllGlobals());

async function seedThread() {
  const [workspace] = await db.insert(workspaces).values({ slackTeamId: "T1", name: "T" }).returning();
  const [namespace] = await db
    .insert(namespaces)
    .values({ workspaceId: workspace.id, channelId: "C1", threadTs: "1.0" })
    .returning();
  const [msg1] = await db
    .insert(messages)
    .values({ namespaceId: namespace.id, slackUserId: "U1", text: "first", slackTs: "1.0" })
    .returning();
  const [msg2] = await db
    .insert(messages)
    .values({ namespaceId: namespace.id, slackUserId: "U2", text: "second", slackTs: "1.1" })
    .returning();
  await db.insert(files).values({
    messageId: msg1.id,
    bucketKey: `messages/${msg1.id}/f1-report.txt`,
    originalName: "report.txt",
    mimeType: "text/plain",
    status: "stored",
  });
  return { workspace, namespace, msg1, msg2 };
}

describe("recallNamespace", () => {
  it("returns messages in order with signed file URLs for a participant", async () => {
    const { workspace, namespace } = await seedThread();

    const result = await recallNamespace(
      db,
      { id: "does-not-matter", workspaceId: workspace.id, slackUserId: "U1" },
      namespace.id,
    );

    expect(result.authorized).toBe(true);
    if (!result.authorized) throw new Error("expected authorized result");
    expect(result.messages.map((m) => m.text)).toEqual(["first", "second"]);
    expect(result.messages[0].files).toHaveLength(1);
    expect(typeof result.messages[0].files[0].url).toBe("string");
  });

  it("is unauthorized for a user who never participated in the thread", async () => {
    const { workspace, namespace } = await seedThread();

    const result = await recallNamespace(
      db,
      { id: "x", workspaceId: workspace.id, slackUserId: "U-STRANGER" },
      namespace.id,
    );

    expect(result.authorized).toBe(false);
  });

  it("is unauthorized for a namespace in a different workspace", async () => {
    const { namespace } = await seedThread();
    const [otherWorkspace] = await db.insert(workspaces).values({ slackTeamId: "T-OTHER", name: "T" }).returning();

    const result = await recallNamespace(
      db,
      { id: "x", workspaceId: otherWorkspace.id, slackUserId: "U1" },
      namespace.id,
    );

    expect(result.authorized).toBe(false);
  });

  it("is unauthorized for a namespace id that doesn't exist", async () => {
    const { workspace } = await seedThread();
    const result = await recallNamespace(
      db,
      { id: "x", workspaceId: workspace.id, slackUserId: "U1" },
      "00000000-0000-0000-0000-000000000000",
    );
    expect(result.authorized).toBe(false);
  });
});

// ─── buildMemoryPlan ────────────────────────────────────────────

const makeMsg = (text: string, walrusStatus: string = "stored") => ({
  id: "00000000-0000-0000-0000-000000000001",
  slackUserId: "U1",
  slackTs: "1.0",
  text,
  createdAt: new Date(),
  files: [],
  walrusBlobId: "blob-1",
  walrusBlobObjectId: "obj-1",
  walrusTxDigest: "tx-1",
  walrusEndEpoch: "100",
  walrusStorageStatus: walrusStatus,
  contentSource: "postgres_cache" as const,
  walrusVerified: false,
});

describe("buildMemoryPlan", () => {
  it("renders a plan with the correct message count and source line", () => {
    const msgs = [
      makeMsg("Implement user auth"),
      makeMsg("Add password reset flow"),
    ];
    const plan = buildMemoryPlan(msgs);

    expect(plan).toContain("# Memory Plan");
    expect(plan).toContain("Source: 2 recalled messages, 2 Walrus-backed.");
    expect(plan).toContain("1. Implement user auth");
    expect(plan).toContain("2. Add password reset flow");
    expect(plan).toContain("## Suggested plan");
  });

  it("omits blank messages from the context", () => {
    const msgs = [
      makeMsg(""),
      makeMsg("real message"),
      makeMsg("   "),
    ];
    const plan = buildMemoryPlan(msgs);

    expect(plan).toContain("1. real message");
    expect(plan).not.toContain("blank message");
    expect(plan).toContain("Source: 3 recalled messages");
  });

  it("caps context at 8 messages", () => {
    const msgs = Array.from({ length: 12 }, (_, i) => makeMsg(`message ${i + 1}`));
    const plan = buildMemoryPlan(msgs);

    expect(plan).toContain("Source: 12 recalled messages");
    expect(plan).not.toContain("message 10");
    expect(plan).toContain("message 8"); // last of the 8 shown
  });

  it("handles zero messages gracefully", () => {
    const plan = buildMemoryPlan([]);
    expect(plan).toContain("# Memory Plan");
    expect(plan).toContain("Source: 0 recalled messages, 0 Walrus-backed.");
    expect(plan).toContain("No message text was captured.");
  });

  it("reports Walrus-backed count accurately when some are pending/failed", () => {
    const msgs = [
      makeMsg("stored msg", "stored"),
      makeMsg("pending msg", "pending"),
      makeMsg("failed msg", "failed"),
    ];
    const plan = buildMemoryPlan(msgs);

    expect(plan).toContain("3 recalled messages, 1 Walrus-backed.");
  });
});

// ─── buildMemoryChecklist ───────────────────────────────────────

describe("buildMemoryChecklist", () => {
  it("renders a checklist with correct message count", () => {
    const msgs = [makeMsg("task one"), makeMsg("task two"), makeMsg("task three")];
    const checklist = buildMemoryChecklist(msgs);

    expect(checklist).toContain("# Memory Checklist");
    expect(checklist).toContain("- [ ] Review 3 recalled messages.");
  });

  it("reports Walrus-backed message count and warns on missing blobs", () => {
    const msgs = [
      makeMsg("one", "stored"),
      makeMsg("two", "pending"),
      makeMsg("three", "failed"),
      makeMsg("four", "stored"),
    ];
    const checklist = buildMemoryChecklist(msgs);

    expect(checklist).toContain("Confirm 2 messages have Walrus blob IDs.");
    expect(checklist).toContain("Backfill or retry 2 messages not stored on Walrus.");
  });

  it("omits backfill step when all messages are stored", () => {
    const msgs = [
      makeMsg("one", "stored"),
      makeMsg("two", "stored"),
    ];
    const checklist = buildMemoryChecklist(msgs);

    expect(checklist).not.toContain("Backfill or retry");
    expect(checklist).toContain("Confirm 2 messages have Walrus blob IDs.");
  });

  it("uses singular form for single messages", () => {
    const msgs = [makeMsg("only one", "pending")];
    const checklist = buildMemoryChecklist(msgs);

    expect(checklist).toContain("1 recalled message.");
    expect(checklist).toContain("Backfill or retry 1 message not stored on Walrus.");
  });

  it("handles zero messages gracefully", () => {
    const checklist = buildMemoryChecklist([]);
    expect(checklist).toContain("# Memory Checklist");
    expect(checklist).toContain("0 recalled messages.");
    expect(checklist).not.toContain("Backfill or retry");
  });
});
