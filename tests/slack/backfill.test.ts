import { describe, it, expect, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../../src/db/client.js";
import { workspaces, namespaces, messages } from "../../src/db/schema.js";
import { backfillThread } from "../../src/slack/backfill.js";

function fakeWebClient(pages: Array<{ messages: any[]; nextCursor?: string }>) {
  let call = 0;
  return {
    conversations: {
      replies: vi.fn().mockImplementation(async () => {
        const page = pages[call];
        call += 1;
        return {
          messages: page.messages,
          response_metadata: page.nextCursor ? { next_cursor: page.nextCursor } : {},
        };
      }),
    },
  } as any;
}

describe("backfillThread", () => {
  it("creates a namespace and stores every message across pages", async () => {
    const [workspace] = await db.insert(workspaces).values({ slackTeamId: "T1", name: "T" }).returning();

    const client = fakeWebClient([
      {
        messages: [
          { ts: "1.000", user: "U1", text: "root message" },
          { ts: "1.001", user: "U2", text: "first reply" },
        ],
        nextCursor: "cursor-2",
      },
      {
        messages: [{ ts: "1.002", user: "U1", text: "second reply" }],
      },
    ]);

    const { namespaceId } = await backfillThread({
      db,
      client,
      workspaceId: workspace.id,
      channelId: "C1",
      threadTs: "1.000",
      botToken: "xoxb-token",
    });

    const [namespace] = await db.select().from(namespaces).where(eq(namespaces.id, namespaceId));
    expect(namespace.channelId).toBe("C1");
    expect(namespace.threadTs).toBe("1.000");
    expect(namespace.status).toBe("active");

    const rows = await db.select().from(messages).where(eq(messages.namespaceId, namespaceId));
    expect(rows).toHaveLength(3);
    expect(client.conversations.replies).toHaveBeenCalledTimes(2);
    expect(client.conversations.replies).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ channel: "C1", ts: "1.000", cursor: undefined }),
    );
    expect(client.conversations.replies).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ channel: "C1", ts: "1.000", cursor: "cursor-2" }),
    );
  });

  it("is idempotent when run twice for the same thread", async () => {
    const [workspace] = await db.insert(workspaces).values({ slackTeamId: "T2", name: "T" }).returning();
    const client = fakeWebClient([{ messages: [{ ts: "2.000", user: "U1", text: "hi" }] }]);

    const first = await backfillThread({
      db,
      client,
      workspaceId: workspace.id,
      channelId: "C2",
      threadTs: "2.000",
      botToken: "xoxb-token",
    });

    const client2 = fakeWebClient([{ messages: [{ ts: "2.000", user: "U1", text: "hi" }] }]);
    const second = await backfillThread({
      db,
      client: client2,
      workspaceId: workspace.id,
      channelId: "C2",
      threadTs: "2.000",
      botToken: "xoxb-token",
    });

    expect(second.namespaceId).toBe(first.namespaceId);
    const rows = await db.select().from(messages).where(eq(messages.namespaceId, first.namespaceId));
    expect(rows).toHaveLength(1);
  });

  it("retries a transient conversations.replies failure and still completes", async () => {
    const [workspace] = await db.insert(workspaces).values({ slackTeamId: "T3", name: "T" }).returning();
    let call = 0;
    const client = {
      conversations: {
        replies: vi.fn().mockImplementation(async () => {
          call += 1;
          if (call === 1) throw new Error("rate_limited");
          return { messages: [{ ts: "3.000", user: "U1", text: "hi" }], response_metadata: {} };
        }),
      },
    } as any;

    const { namespaceId } = await backfillThread({
      db,
      client,
      workspaceId: workspace.id,
      channelId: "C3",
      threadTs: "3.000",
      botToken: "xoxb-token",
      retryDelayMs: 1, // keep the test fast; production default is defined in backfill.ts
    });

    const rows = await db.select().from(messages).where(eq(messages.namespaceId, namespaceId));
    expect(rows).toHaveLength(1);
    expect(client.conversations.replies).toHaveBeenCalledTimes(2);
  });

  it("gives up after the max retry attempts but keeps whatever was already inserted", async () => {
    const [workspace] = await db.insert(workspaces).values({ slackTeamId: "T4", name: "T" }).returning();
    const client = {
      conversations: {
        replies: vi.fn().mockImplementation(async () => {
          throw new Error("rate_limited");
        }),
      },
    } as any;

    await expect(
      backfillThread({
        db,
        client,
        workspaceId: workspace.id,
        channelId: "C4",
        threadTs: "4.000",
        botToken: "xoxb-token",
        retryDelayMs: 1,
      }),
    ).rejects.toThrow("rate_limited");

    // the namespace row itself is still created (inserted before any Slack API call),
    // so a later re-invocation of backfillThread for the same thread resumes into it
    // via onConflictDoNothing rather than duplicating it.
    const [namespace] = await db
      .select()
      .from(namespaces)
      .where(and(eq(namespaces.workspaceId, workspace.id), eq(namespaces.channelId, "C4"), eq(namespaces.threadTs, "4.000")));
    expect(namespace).toBeDefined();
  });
});
