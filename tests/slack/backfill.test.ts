import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { mockClient } from "aws-sdk-client-mock";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { db } from "../../src/db/client.js";
import { workspaces, namespaces, messages, files, namespaceLinearIssues } from "../../src/db/schema.js";
import { backfillThread } from "../../src/slack/backfill.js";

const s3Mock = mockClient(S3Client);

beforeEach(() => {
  s3Mock.reset();
  s3Mock.on(PutObjectCommand).resolves({});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

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

  it("retries a previously-failed file capture when the message is re-processed", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const [workspace] = await db.insert(workspaces).values({ slackTeamId: "T5", name: "T" }).returning();

    const rawMessage = {
      ts: "5.000",
      user: "U1",
      text: "here is the spec",
      files: [
        {
          id: "F5",
          name: "spec.txt",
          mimetype: "text/plain",
          url_private: "https://files.slack.com/f5",
          size: 12,
        },
      ],
    };

    // first pass: Slack is down for file downloads, so the attachment lands at status='failed'
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, statusText: "Server Error" }));
    const { namespaceId } = await backfillThread({
      db,
      client: fakeWebClient([{ messages: [rawMessage] }]),
      workspaceId: workspace.id,
      channelId: "C5",
      threadTs: "5.000",
      botToken: "xoxb-token",
    });

    const [messageRow] = await db.select().from(messages).where(eq(messages.namespaceId, namespaceId));
    let fileRows = await db.select().from(files).where(eq(files.messageId, messageRow.id));
    expect(fileRows).toHaveLength(1);
    expect(fileRows[0].status).toBe("failed");
    consoleError.mockRestore();

    // second pass (user re-tags the thread): the message already exists, so onConflictDoNothing
    // returns nothing — the stranded attachment must still be retried.
    const okFetch = vi
      .fn()
      .mockResolvedValue({ ok: true, arrayBuffer: async () => new TextEncoder().encode("spec-bytes").buffer });
    vi.stubGlobal("fetch", okFetch);
    await backfillThread({
      db,
      client: fakeWebClient([{ messages: [rawMessage] }]),
      workspaceId: workspace.id,
      channelId: "C5",
      threadTs: "5.000",
      botToken: "xoxb-token",
    });

    expect(okFetch).toHaveBeenCalledWith("https://files.slack.com/f5", expect.anything());
    fileRows = await db.select().from(files).where(eq(files.messageId, messageRow.id));
    expect(fileRows).toHaveLength(1); // the stale failed row is replaced, not duplicated
    expect(fileRows[0].status).toBe("stored");
    expect(await db.select().from(messages).where(eq(messages.namespaceId, namespaceId))).toHaveLength(1);
  });

  it("does not re-download files that were already stored on an earlier pass", async () => {
    const [workspace] = await db.insert(workspaces).values({ slackTeamId: "T6", name: "T" }).returning();
    const rawMessage = {
      ts: "6.000",
      user: "U1",
      text: "here is the spec",
      files: [
        { id: "F6", name: "spec.txt", mimetype: "text/plain", url_private: "https://files.slack.com/f6", size: 12 },
      ],
    };

    const firstFetch = vi
      .fn()
      .mockResolvedValue({ ok: true, arrayBuffer: async () => new TextEncoder().encode("bytes").buffer });
    vi.stubGlobal("fetch", firstFetch);
    const { namespaceId } = await backfillThread({
      db,
      client: fakeWebClient([{ messages: [rawMessage] }]),
      workspaceId: workspace.id,
      channelId: "C6",
      threadTs: "6.000",
      botToken: "xoxb-token",
    });
    expect(firstFetch).toHaveBeenCalledTimes(1);

    const secondFetch = vi.fn();
    vi.stubGlobal("fetch", secondFetch);
    await backfillThread({
      db,
      client: fakeWebClient([{ messages: [rawMessage] }]),
      workspaceId: workspace.id,
      channelId: "C6",
      threadTs: "6.000",
      botToken: "xoxb-token",
    });

    expect(secondFetch).not.toHaveBeenCalled();
    const [messageRow] = await db.select().from(messages).where(eq(messages.namespaceId, namespaceId));
    const fileRows = await db.select().from(files).where(eq(files.messageId, messageRow.id));
    expect(fileRows).toHaveLength(1);
    expect(fileRows[0].status).toBe("stored");
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

  it("populates the join table from a Linear link found during a thread replay", async () => {
    const [workspace] = await db.insert(workspaces).values({ slackTeamId: "TL1", name: "T" }).returning();
    const client = fakeWebClient([
      { messages: [{ ts: "30.000", user: "U1", text: "see <https://linear.app/mysten-labs/issue/WALM-9>" }] },
    ]);

    const { namespaceId } = await backfillThread({
      db,
      client,
      workspaceId: workspace.id,
      channelId: "C30",
      threadTs: "30.000",
      botToken: "xoxb-token",
    });

    const rows = await db.select().from(namespaceLinearIssues).where(eq(namespaceLinearIssues.namespaceId, namespaceId));
    expect(rows).toHaveLength(1);
    expect(rows[0].issueIdentifier).toBe("WALM-9");
  });

  it("retroactively detects a Linear link in a message captured before this feature existed", async () => {
    const [workspace] = await db.insert(workspaces).values({ slackTeamId: "TL2", name: "T" }).returning();
    const [namespace] = await db
      .insert(namespaces)
      .values({ workspaceId: workspace.id, channelId: "C31", threadTs: "31.000" })
      .returning();
    // Simulates a message stored by an earlier backfill, before Linear link detection shipped.
    await db.insert(messages).values({
      namespaceId: namespace.id,
      slackUserId: "U1",
      text: "see <https://linear.app/mysten-labs/issue/WALM-10>",
      slackTs: "31.000",
    });

    const client = fakeWebClient([
      { messages: [{ ts: "31.000", user: "U1", text: "see <https://linear.app/mysten-labs/issue/WALM-10>" }] },
    ]);

    await backfillThread({ db, client, workspaceId: workspace.id, channelId: "C31", threadTs: "31.000", botToken: "xoxb-token" });

    const rows = await db.select().from(namespaceLinearIssues).where(eq(namespaceLinearIssues.namespaceId, namespace.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].issueIdentifier).toBe("WALM-10");
  });
});
