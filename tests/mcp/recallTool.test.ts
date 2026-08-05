import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { S3Client } from "@aws-sdk/client-s3";
import { db } from "../../src/db/client.js";
import { workspaces, namespaces, messages, files } from "../../src/db/schema.js";
import { recallNamespace } from "../../src/mcp/recallTool.js";

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
