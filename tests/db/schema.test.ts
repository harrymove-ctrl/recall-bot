import { describe, it, expect } from "vitest";
import { db } from "../../src/db/client.js";
import { workspaces, namespaces } from "../../src/db/schema.js";

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
});
