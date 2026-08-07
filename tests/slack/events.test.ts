import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { mockClient } from "aws-sdk-client-mock";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { db } from "../../src/db/client.js";
import { workspaces, namespaces, messages, files, namespaceLinearIssues } from "../../src/db/schema.js";
import {
  handleAppMention,
  handleMessage,
  isCapturableMessageSubtype,
  registerEventHandlers,
} from "../../src/slack/events.js";

const s3Mock = mockClient(S3Client);

beforeEach(() => {
  s3Mock.reset();
  s3Mock.on(PutObjectCommand).resolves({});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function fakeClient(replies: any[] = []) {
  return {
    conversations: {
      replies: vi.fn().mockResolvedValue({ messages: replies, response_metadata: {} }),
    },
    chat: {
      postMessage: vi.fn().mockResolvedValue({ ok: true }),
    },
  } as any;
}

/**
 * Captures the listeners `registerEventHandlers` registers so they can be invoked directly.
 * Bolt only ever calls them with a `{ event | message, client, context }` args object, so a
 * synthetic one is enough to exercise the wrapper logic (team resolution, subtype filtering)
 * that the handleX unit tests bypass entirely.
 */
function fakeBoltApp() {
  const registered: { eventName?: string; eventListener?: Function; messageListener?: Function } = {};
  const app = {
    event: (eventName: string, listener: Function) => {
      registered.eventName = eventName;
      registered.eventListener = listener;
    },
    message: (listener: Function) => {
      registered.messageListener = listener;
    },
  };
  return { app: app as any, registered };
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

  it("replies in-thread with the namespace id so it is discoverable for the MCP recall tool", async () => {
    const [workspace] = await db.insert(workspaces).values({ slackTeamId: "T1b", name: "T" }).returning();
    const client = fakeClient([{ ts: "5.000", user: "U1", text: "root" }]);

    await handleAppMention({
      db,
      client,
      botToken: "xoxb-token",
      event: { channel: "C5", ts: "5.010", thread_ts: "5.000", user: "U9", text: "<@BOT> save this" } as any,
      workspaceId: workspace.id,
    });

    const [namespace] = await db
      .select()
      .from(namespaces)
      .where(and(eq(namespaces.workspaceId, workspace.id), eq(namespaces.channelId, "C5")));

    expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
    const call = client.chat.postMessage.mock.calls[0][0];
    expect(call.channel).toBe("C5");
    expect(call.thread_ts).toBe("5.000");
    expect(call.text).toContain(namespace.id);
    expect(call.text).toContain("/recall-key");
  });

  it("still completes the capture when the confirmation reply fails to post", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const [workspace] = await db.insert(workspaces).values({ slackTeamId: "T1c", name: "T" }).returning();
    const client = fakeClient([{ ts: "6.000", user: "U1", text: "root" }]);
    client.chat.postMessage.mockRejectedValue(new Error("missing_scope"));

    await expect(
      handleAppMention({
        db,
        client,
        botToken: "xoxb-token",
        event: { channel: "C6", ts: "6.000", thread_ts: undefined, user: "U9", text: "<@BOT> save this" } as any,
        workspaceId: workspace.id,
      }),
    ).resolves.toBeUndefined();

    const rows = await db.select().from(messages);
    expect(rows).toHaveLength(1);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
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

  it("records a Linear issue link found in a captured reply", async () => {
    const [workspace] = await db.insert(workspaces).values({ slackTeamId: "T2b", name: "T" }).returning();
    const [namespace] = await db
      .insert(namespaces)
      .values({ workspaceId: workspace.id, channelId: "C2b", threadTs: "2.100" })
      .returning();

    await handleMessage({
      db,
      botToken: "xoxb-token",
      workspaceId: workspace.id,
      message: {
        channel: "C2b",
        ts: "2.101",
        thread_ts: "2.100",
        user: "U1",
        text: "blocked by <https://linear.app/mysten-labs/issue/WALM-297>",
      } as any,
    });

    const rows = await db.select().from(namespaceLinearIssues).where(eq(namespaceLinearIssues.namespaceId, namespace.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].issueIdentifier).toBe("WALM-297");
  });

  it("records nothing for a message with no Linear link", async () => {
    const [workspace] = await db.insert(workspaces).values({ slackTeamId: "T2c", name: "T" }).returning();
    const [namespace] = await db
      .insert(namespaces)
      .values({ workspaceId: workspace.id, channelId: "C2c", threadTs: "2.200" })
      .returning();

    await handleMessage({
      db,
      botToken: "xoxb-token",
      workspaceId: workspace.id,
      message: { channel: "C2c", ts: "2.201", thread_ts: "2.200", user: "U1", text: "no link here" } as any,
    });

    const rows = await db.select().from(namespaceLinearIssues).where(eq(namespaceLinearIssues.namespaceId, namespace.id));
    expect(rows).toHaveLength(0);
  });
});

describe("isCapturableMessageSubtype", () => {
  it("allows plain messages, file uploads and 'also send to channel' thread replies", () => {
    expect(isCapturableMessageSubtype(undefined)).toBe(true);
    expect(isCapturableMessageSubtype("file_share")).toBe(true);
    expect(isCapturableMessageSubtype("thread_broadcast")).toBe(true);
  });

  it("drops bot echoes and edits/deletes of messages we already stored", () => {
    expect(isCapturableMessageSubtype("bot_message")).toBe(false);
    expect(isCapturableMessageSubtype("message_changed")).toBe(false);
    expect(isCapturableMessageSubtype("message_deleted")).toBe(false);
    expect(isCapturableMessageSubtype("message_replied")).toBe(false);
    expect(isCapturableMessageSubtype("channel_join")).toBe(false);
  });
});

describe("registerEventHandlers", () => {
  it("registers an app_mention event listener and a message listener", () => {
    const { app, registered } = fakeBoltApp();
    registerEventHandlers(app, db);

    expect(registered.eventName).toBe("app_mention");
    expect(registered.eventListener).toBeTypeOf("function");
    expect(registered.messageListener).toBeTypeOf("function");
  });

  it("resolves the workspace from context.teamId and backfills on app_mention", async () => {
    const [workspace] = await db.insert(workspaces).values({ slackTeamId: "T10", name: "T" }).returning();
    const { app, registered } = fakeBoltApp();
    registerEventHandlers(app, db);

    const client = fakeClient([{ ts: "10.000", user: "U1", text: "root" }]);
    await registered.eventListener!({
      event: { channel: "C10", ts: "10.000", user: "U9", text: "<@BOT> save this" },
      client,
      context: { teamId: "T10", botToken: "xoxb-token" },
    });

    const [namespace] = await db
      .select()
      .from(namespaces)
      .where(and(eq(namespaces.workspaceId, workspace.id), eq(namespaces.channelId, "C10")));
    expect(namespace).toBeDefined();
    expect(client.conversations.replies).toHaveBeenCalled();
  });

  it("returns early on app_mention from an unknown team without touching Slack", async () => {
    const { app, registered } = fakeBoltApp();
    registerEventHandlers(app, db);

    const client = fakeClient([{ ts: "11.000", user: "U1", text: "root" }]);
    await registered.eventListener!({
      event: { channel: "C11", ts: "11.000", user: "U9", text: "<@BOT> save this" },
      client,
      context: { teamId: "T-not-installed", botToken: "xoxb-token" },
    });

    expect(client.conversations.replies).not.toHaveBeenCalled();
    expect(await db.select().from(namespaces)).toHaveLength(0);
  });

  it("captures a plain thread reply through the message listener", async () => {
    const [workspace] = await db.insert(workspaces).values({ slackTeamId: "T12", name: "T" }).returning();
    const [namespace] = await db
      .insert(namespaces)
      .values({ workspaceId: workspace.id, channelId: "C12", threadTs: "12.000" })
      .returning();

    const { app, registered } = fakeBoltApp();
    registerEventHandlers(app, db);

    await registered.messageListener!({
      message: { channel: "C12", ts: "12.001", thread_ts: "12.000", user: "U1", text: "plain reply" },
      context: { teamId: "T12", botToken: "xoxb-token" },
    });

    const rows = await db.select().from(messages).where(eq(messages.namespaceId, namespace.id));
    expect(rows).toHaveLength(1);
  });

  it("returns early on a message from an unknown team", async () => {
    const [workspace] = await db.insert(workspaces).values({ slackTeamId: "T13", name: "T" }).returning();
    await db.insert(namespaces).values({ workspaceId: workspace.id, channelId: "C13", threadTs: "13.000" });

    const { app, registered } = fakeBoltApp();
    registerEventHandlers(app, db);

    await registered.messageListener!({
      message: { channel: "C13", ts: "13.001", thread_ts: "13.000", user: "U1", text: "dropped" },
      context: { teamId: "T-not-installed", botToken: "xoxb-token" },
    });

    expect(await db.select().from(messages)).toHaveLength(0);
  });

  it("captures a file_share message (and its attachment) instead of dropping it as a subtype", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => new TextEncoder().encode("bytes").buffer }),
    );
    const [workspace] = await db.insert(workspaces).values({ slackTeamId: "T14", name: "T" }).returning();
    const [namespace] = await db
      .insert(namespaces)
      .values({ workspaceId: workspace.id, channelId: "C14", threadTs: "14.000" })
      .returning();

    const { app, registered } = fakeBoltApp();
    registerEventHandlers(app, db);

    await registered.messageListener!({
      message: {
        subtype: "file_share",
        channel: "C14",
        ts: "14.001",
        thread_ts: "14.000",
        user: "U1",
        text: "here is the spec",
        files: [
          {
            id: "F14",
            name: "spec.txt",
            mimetype: "text/plain",
            url_private: "https://files.slack.com/f14",
            size: 10,
          },
        ],
      },
      context: { teamId: "T14", botToken: "xoxb-token" },
    });

    const rows = await db.select().from(messages).where(eq(messages.namespaceId, namespace.id));
    expect(rows).toHaveLength(1);
    const fileRows = await db.select().from(files).where(eq(files.messageId, rows[0].id));
    expect(fileRows).toHaveLength(1);
    expect(fileRows[0].status).toBe("stored");
  });

  it("captures a thread_broadcast reply instead of dropping it as a subtype", async () => {
    const [workspace] = await db.insert(workspaces).values({ slackTeamId: "T15", name: "T" }).returning();
    const [namespace] = await db
      .insert(namespaces)
      .values({ workspaceId: workspace.id, channelId: "C15", threadTs: "15.000" })
      .returning();

    const { app, registered } = fakeBoltApp();
    registerEventHandlers(app, db);

    await registered.messageListener!({
      message: {
        subtype: "thread_broadcast",
        channel: "C15",
        ts: "15.001",
        thread_ts: "15.000",
        user: "U1",
        text: "broadcast reply",
      },
      context: { teamId: "T15", botToken: "xoxb-token" },
    });

    const rows = await db.select().from(messages).where(eq(messages.namespaceId, namespace.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toBe("broadcast reply");
  });

  it("drops a bot_message subtype", async () => {
    const [workspace] = await db.insert(workspaces).values({ slackTeamId: "T16", name: "T" }).returning();
    await db.insert(namespaces).values({ workspaceId: workspace.id, channelId: "C16", threadTs: "16.000" });

    const { app, registered } = fakeBoltApp();
    registerEventHandlers(app, db);

    await registered.messageListener!({
      message: {
        subtype: "bot_message",
        channel: "C16",
        ts: "16.001",
        thread_ts: "16.000",
        user: "U1",
        text: "beep boop",
      },
      context: { teamId: "T16", botToken: "xoxb-token" },
    });

    expect(await db.select().from(messages)).toHaveLength(0);
  });
});
