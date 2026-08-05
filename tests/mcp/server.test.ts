import { describe, it, expect } from "vitest";
import express from "express";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { db } from "../../src/db/client.js";
import { workspaces, namespaces, messages } from "../../src/db/schema.js";
import { mountMcpServer } from "../../src/mcp/server.js";
import { generateDelegateKey } from "../../src/keys/delegateKeys.js";
import { eq } from "drizzle-orm";
import { users } from "../../src/db/schema.js";

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
        { slackUserId: "U1", text: "hello", slackTs: "1.0", files: [] },
      ]);
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
});
