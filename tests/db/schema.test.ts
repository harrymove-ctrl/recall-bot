import { describe, it, expect } from "vitest";
import { db } from "../../src/db/client.js";
import { workspaces, namespaces, workspaceClaimTokens } from "../../src/db/schema.js";

describe("schema", () => {
  it("enforces the namespaces workspace+channel+thread unique constraint", async () => {
    const [workspace] = await db
      .insert(workspaces)
      .values({ slackTeamId: "T123", name: "Test Workspace" })
      .returning();

    await db.insert(namespaces).values({
      workspaceId: workspace.id,
      channelId: "C1",
      threadTs: "111.222",
    });

    await expect(
      db.insert(namespaces).values({
        workspaceId: workspace.id,
        channelId: "C1",
        threadTs: "111.222",
      }),
    ).rejects.toThrow();
  });

  it("enforces a unique tokenHash on workspace_claim_tokens and allows a nullable namespace label", async () => {
    const [workspace] = await db
      .insert(workspaces)
      .values({ slackTeamId: "T-CLAIM", name: "Test Workspace" })
      .returning();

    await db.insert(workspaceClaimTokens).values({
      workspaceId: workspace.id,
      tokenHash: "abc123",
      expiresAt: new Date(Date.now() + 1000 * 60 * 60),
    });

    await expect(
      db.insert(workspaceClaimTokens).values({
        workspaceId: workspace.id,
        tokenHash: "abc123",
        expiresAt: new Date(Date.now() + 1000 * 60 * 60),
      }),
    ).rejects.toThrow();

    const [namespace] = await db
      .insert(namespaces)
      .values({ workspaceId: workspace.id, channelId: "C1", threadTs: "1.1", label: null })
      .returning();
    expect(namespace.label).toBeNull();
  });
});
