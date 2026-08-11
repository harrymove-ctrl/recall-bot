import { describe, it, expect, vi } from "vitest";
import express from "express";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { db } from "../../src/db/client.js";
import { workspaces, namespaces, messages, recallEvents } from "../../src/db/schema.js";
import { mountMcpServer } from "../../src/mcp/server.js";
import { generateDelegateKey } from "../../src/keys/delegateKeys.js";
import { eq } from "drizzle-orm";
import { users } from "../../src/db/schema.js";
import { logRecallEvent } from "../../src/mcp/recallEvents.js";

vi.mock("../../src/mcp/recallEvents.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/mcp/recallEvents.js")>();
  return { ...actual, logRecallEvent: vi.fn(actual.logRecallEvent) };
});

async function startTestServer() {
  const app = express();
  app.use(express.json());
  mountMcpServer(app, db);
  const httpServer = createServer(app);
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const { port } = httpServer.address() as AddressInfo;
  return { httpServer, url: `http://127.0.0.1:${port}/mcp` };
}

describe("mountMcpServer", () => {
  it("rejects a call to the recall tool with no Authorization header", async () => {
    const { httpServer, url } = await startTestServer();
    try {
      const transport = new StreamableHTTPClientTransport(new URL(url));
      const client = new Client({ name: "test-client", version: "1.0.0" });
      await expect(client.connect(transport)).rejects.toThrow();
    } finally {
      httpServer.close();
    }
  });

  it("returns the thread's messages for an authorized delegate key", async () => {
    const [workspace] = await db.insert(workspaces).values({ slackTeamId: "T1", name: "T" }).returning();
    const [namespace] = await db
      .insert(namespaces)
      .values({ workspaceId: workspace.id, channelId: "C1", threadTs: "1.0" })
      .returning();
    await db.insert(messages).values({ namespaceId: namespace.id, slackUserId: "U1", text: "hello", slackTs: "1.0" });

    const { plaintext, hash } = generateDelegateKey();
    await db.insert(users).values({ workspaceId: workspace.id, slackUserId: "U1", delegateKeyHash: hash });

    const { httpServer, url } = await startTestServer();
    try {
      const transport = new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { Authorization: `Bearer ${plaintext}` } },
      });
      const client = new Client({ name: "test-client", version: "1.0.0" });
      await client.connect(transport);

      const result = await client.callTool({ name: "recall", arguments: { namespaceId: namespace.id } });
      const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? "";
      const parsed = JSON.parse(text);

      expect(parsed.namespaceId).toBe(namespace.id);
      expect(parsed.messages).toEqual([
        { slackUserId: "U1", text: "hello", slackTs: "1.0", walrusBlobId: null, walrusStorageStatus: "pending", files: [] },
      ]);
    } finally {
      httpServer.close();
    }
  });

  it("lists only namespaces the delegate user participated in", async () => {
    const [workspace] = await db.insert(workspaces).values({ slackTeamId: "T-LIST", name: "T" }).returning();
    const [mine] = await db
      .insert(namespaces)
      .values({ workspaceId: workspace.id, channelId: "C1", threadTs: "1.0", label: "Mine" })
      .returning();
    const [theirs] = await db
      .insert(namespaces)
      .values({ workspaceId: workspace.id, channelId: "C2", threadTs: "2.0", label: "Theirs" })
      .returning();
    await db.insert(messages).values([
      { namespaceId: mine.id, slackUserId: "U1", text: "mine", slackTs: "1.0" },
      { namespaceId: theirs.id, slackUserId: "U2", text: "theirs", slackTs: "2.0" },
    ]);

    const { plaintext, hash } = generateDelegateKey();
    await db.insert(users).values({ workspaceId: workspace.id, slackUserId: "U1", delegateKeyHash: hash });

    const { httpServer, url } = await startTestServer();
    try {
      const transport = new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { Authorization: `Bearer ${plaintext}` } },
      });
      const client = new Client({ name: "test-client", version: "1.0.0" });
      await client.connect(transport);

      const result = await client.callTool({ name: "list_namespaces", arguments: {} });
      const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? "";
      const parsed = JSON.parse(text);

      expect(parsed.namespaces.map((n: { id: string }) => n.id)).toEqual([mine.id]);
    } finally {
      httpServer.close();
    }
  });

  it("generates a plan and checklist from a recalled namespace", async () => {
    const [workspace] = await db.insert(workspaces).values({ slackTeamId: "T-PLAN", name: "T" }).returning();
    const [namespace] = await db
      .insert(namespaces)
      .values({ workspaceId: workspace.id, channelId: "C1", threadTs: "1.0" })
      .returning();
    await db
      .insert(messages)
      .values({ namespaceId: namespace.id, slackUserId: "U1", text: "ship walrus-backed recall", slackTs: "1.0", walrusBlobId: "blob-1", walrusStorageStatus: "stored" });

    const { plaintext, hash } = generateDelegateKey();
    await db.insert(users).values({ workspaceId: workspace.id, slackUserId: "U1", delegateKeyHash: hash });

    const { httpServer, url } = await startTestServer();
    try {
      const transport = new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { Authorization: `Bearer ${plaintext}` } },
      });
      const client = new Client({ name: "test-client", version: "1.0.0" });
      await client.connect(transport);

      const plan = await client.callTool({ name: "memory_plan", arguments: { namespaceId: namespace.id } });
      const checklist = await client.callTool({ name: "memory_checklist", arguments: { namespaceId: namespace.id } });
      const planText = (plan.content as Array<{ type: string; text?: string }>)[0]?.text ?? "";
      const checklistText = (checklist.content as Array<{ type: string; text?: string }>)[0]?.text ?? "";

      expect(planText).toContain("# Memory Plan");
      expect(planText).toContain("ship walrus-backed recall");
      expect(checklistText).toContain("# Memory Checklist");
      expect(checklistText).toContain("Confirm 1 message have Walrus blob IDs");
    } finally {
      httpServer.close();
    }
  });

  it("returns isError for a namespace the caller didn't participate in", async () => {
    const [workspace] = await db.insert(workspaces).values({ slackTeamId: "T2", name: "T" }).returning();
    const [namespace] = await db
      .insert(namespaces)
      .values({ workspaceId: workspace.id, channelId: "C2", threadTs: "2.0" })
      .returning();
    await db.insert(messages).values({ namespaceId: namespace.id, slackUserId: "U-OTHER", text: "hi", slackTs: "2.0" });

    const { plaintext, hash } = generateDelegateKey();
    await db.insert(users).values({ workspaceId: workspace.id, slackUserId: "U-ME", delegateKeyHash: hash });

    const { httpServer, url } = await startTestServer();
    try {
      const transport = new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { Authorization: `Bearer ${plaintext}` } },
      });
      const client = new Client({ name: "test-client", version: "1.0.0" });
      await client.connect(transport);

      const result = await client.callTool({ name: "recall", arguments: { namespaceId: namespace.id } });
      expect(result.isError).toBe(true);
    } finally {
      httpServer.close();
    }
  });

  it("logs exactly one recall_events row on a successful call", async () => {
    const [workspace] = await db.insert(workspaces).values({ slackTeamId: "T20", name: "T" }).returning();
    const [namespace] = await db
      .insert(namespaces)
      .values({ workspaceId: workspace.id, channelId: "C20", threadTs: "20.0" })
      .returning();
    await db.insert(messages).values({ namespaceId: namespace.id, slackUserId: "U1", text: "hi", slackTs: "20.0" });
    const { plaintext, hash } = generateDelegateKey();
    await db.insert(users).values({ workspaceId: workspace.id, slackUserId: "U1", delegateKeyHash: hash });

    const { httpServer, url } = await startTestServer();
    try {
      const transport = new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { Authorization: `Bearer ${plaintext}` } },
      });
      const client = new Client({ name: "test-client", version: "1.0.0" });
      await client.connect(transport);

      await client.callTool({ name: "recall", arguments: { namespaceId: namespace.id } });

      // logRecallEvent is fire-and-forget from the server's perspective, but it's invoked
      // synchronously before the tool response is sent, so the mock has already recorded the
      // call (and the real promise it returned) by the time callTool() resolves. Await that
      // promise directly instead of guessing with a timeout — a real network round-trip to
      // Postgres has no fixed duration, so a fixed-tick wait is a race, not a guarantee.
      const lastCall = vi.mocked(logRecallEvent).mock.results.at(-1);
      await lastCall?.value;

      const rows = await db.select().from(recallEvents).where(eq(recallEvents.namespaceId, namespace.id));
      expect(rows).toHaveLength(1);
    } finally {
      httpServer.close();
    }
  });

  it("does not log an event for an unauthorized recall call", async () => {
    const [workspace] = await db.insert(workspaces).values({ slackTeamId: "T21", name: "T" }).returning();
    const [namespace] = await db
      .insert(namespaces)
      .values({ workspaceId: workspace.id, channelId: "C21", threadTs: "21.0" })
      .returning();
    await db.insert(messages).values({ namespaceId: namespace.id, slackUserId: "U-OTHER", text: "hi", slackTs: "21.0" });
    const { plaintext, hash } = generateDelegateKey();
    await db.insert(users).values({ workspaceId: workspace.id, slackUserId: "U-ME", delegateKeyHash: hash });

    const { httpServer, url } = await startTestServer();
    try {
      const transport = new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { Authorization: `Bearer ${plaintext}` } },
      });
      const client = new Client({ name: "test-client", version: "1.0.0" });
      await client.connect(transport);

      const result = await client.callTool({ name: "recall", arguments: { namespaceId: namespace.id } });
      expect(result.isError).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 0));

      const rows = await db.select().from(recallEvents).where(eq(recallEvents.namespaceId, namespace.id));
      expect(rows).toHaveLength(0);
    } finally {
      httpServer.close();
    }
  });

  it("still returns the recall response, and logs to console.error, when logging the event fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(logRecallEvent).mockRejectedValueOnce(new Error("db unavailable"));

    const [workspace] = await db.insert(workspaces).values({ slackTeamId: "T22", name: "T" }).returning();
    const [namespace] = await db
      .insert(namespaces)
      .values({ workspaceId: workspace.id, channelId: "C22", threadTs: "22.0" })
      .returning();
    await db.insert(messages).values({ namespaceId: namespace.id, slackUserId: "U1", text: "hi", slackTs: "22.0" });
    const { plaintext, hash } = generateDelegateKey();
    await db.insert(users).values({ workspaceId: workspace.id, slackUserId: "U1", delegateKeyHash: hash });

    const { httpServer, url } = await startTestServer();
    try {
      const transport = new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { Authorization: `Bearer ${plaintext}` } },
      });
      const client = new Client({ name: "test-client", version: "1.0.0" });
      await client.connect(transport);

      const result = await client.callTool({ name: "recall", arguments: { namespaceId: namespace.id } });
      expect(result.isError).toBeUndefined();
      const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? "";
      expect(JSON.parse(text).messages).toHaveLength(1);

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(consoleError).toHaveBeenCalledWith("Failed to log recall event:", expect.any(Error));
    } finally {
      httpServer.close();
      consoleError.mockRestore();
    }
  });
});
