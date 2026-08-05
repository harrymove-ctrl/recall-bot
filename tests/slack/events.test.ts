import { describe, it, expect, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../../src/db/client.js";
import { workspaces, namespaces, messages } from "../../src/db/schema.js";
import { handleAppMention, handleMessage } from "../../src/slack/events.js";

function fakeClient(replies: any[] = []) {
  return {
    conversations: {
      replies: vi.fn().mockResolvedValue({ messages: replies, response_metadata: {} }),
    },
  } as any;
}

describe("handleAppMention", () => {
  it("backfills the thread and marks the namespace active", async () => {
    const [workspace] = await db.insert(workspaces).values({ slackTeamId: "T1", name: "T" }).returning();
    const client = fakeClient([{ ts: "1.000", user: "U1", text: "root" }]);

    await handleAppMention({
      db,
      client,
      botToken: "xoxb-token",
      event: { channel: "C1", ts: "1.000", thread_ts: undefined, user: "U9", text: "<@BOT> help" } as any,
      workspaceId: workspace.id,
    });

    const [namespace] = await db
      .select()
      .from(namespaces)
      .where(and(eq(namespaces.workspaceId, workspace.id), eq(namespaces.channelId, "C1"), eq(namespaces.threadTs, "1.000")));
    expect(namespace).toBeDefined();
    expect(namespace.status).toBe("active");
  });
});

describe("handleMessage", () => {
  it("appends a reply to an existing active namespace", async () => {
    const [workspace] = await db.insert(workspaces).values({ slackTeamId: "T2", name: "T" }).returning();
    const [namespace] = await db
      .insert(namespaces)
      .values({ workspaceId: workspace.id, channelId: "C2", threadTs: "2.000" })
      .returning();

    await handleMessage({
      db,
      botToken: "xoxb-token",
      workspaceId: workspace.id,
      message: { channel: "C2", ts: "2.001", thread_ts: "2.000", user: "U1", text: "a reply" } as any,
    });

    const rows = await db.select().from(messages).where(eq(messages.namespaceId, namespace.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toBe("a reply");
  });

  it("drops a message whose thread has no active namespace", async () => {
    const [workspace] = await db.insert(workspaces).values({ slackTeamId: "T3", name: "T" }).returning();

    await handleMessage({
      db,
      botToken: "xoxb-token",
      workspaceId: workspace.id,
      message: { channel: "C3", ts: "3.001", thread_ts: "3.000", user: "U1", text: "ignored" } as any,
    });

    const rows = await db.select().from(messages);
    expect(rows).toHaveLength(0);
  });

  it("ignores a top-level message that is not a thread reply", async () => {
    const [workspace] = await db.insert(workspaces).values({ slackTeamId: "T4", name: "T" }).returning();

    await handleMessage({
      db,
      botToken: "xoxb-token",
      workspaceId: workspace.id,
      message: { channel: "C4", ts: "4.001", thread_ts: undefined, user: "U1", text: "not a reply" } as any,
    });

    const rows = await db.select().from(messages);
    expect(rows).toHaveLength(0);
  });
});
