import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/client.js";
import { workspaces, namespaces, users, recallEvents } from "../../src/db/schema.js";
import { logRecallEvent } from "../../src/mcp/recallEvents.js";

describe("logRecallEvent", () => {
  it("inserts exactly one row with the given namespaceId/delegateUserId and a fresh createdAt", async () => {
    const [workspace] = await db.insert(workspaces).values({ slackTeamId: "T1", name: "T" }).returning();
    const [namespace] = await db
      .insert(namespaces)
      .values({ workspaceId: workspace.id, channelId: "C1", threadTs: "1.0" })
      .returning();
    const [user] = await db.insert(users).values({ workspaceId: workspace.id, slackUserId: "U1" }).returning();

    const before = Date.now();
    await logRecallEvent(db, namespace.id, user.id);
    const after = Date.now();

    const rows = await db.select().from(recallEvents).where(eq(recallEvents.namespaceId, namespace.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].delegateUserId).toBe(user.id);
    expect(rows[0].createdAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(rows[0].createdAt.getTime()).toBeLessThanOrEqual(after + 1000);
  });

  it("rejects when given a namespaceId that doesn't exist (FK violation) — callers must expect this to throw", async () => {
    const [workspace] = await db.insert(workspaces).values({ slackTeamId: "T2", name: "T" }).returning();
    const [user] = await db.insert(users).values({ workspaceId: workspace.id, slackUserId: "U2" }).returning();

    await expect(logRecallEvent(db, "00000000-0000-0000-0000-000000000000", user.id)).rejects.toThrow();
  });
});
