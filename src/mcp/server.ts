import type { Express, Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Database } from "../db/client.js";
import { requireDelegateKey, type AuthedRequest, type DelegateUser } from "./auth.js";
import { logRecallEvent } from "./recallEvents.js";
import { buildMemoryChecklist, buildMemoryPlan, listDelegateNamespaces, recallNamespace, verifyWalrusMessageBlob } from "./recallTool.js";

function buildRecallServer(db: Database, delegateUser: DelegateUser | undefined): McpServer {
  const server = new McpServer({ name: "recall-mcp-server", version: "1.0.0" });

  server.registerTool(
    "list_namespaces",
    {
      title: "List my namespaces",
      description: "Lists namespaces the authenticated Slack user participated in and may recall",
      inputSchema: {},
    },
    async (): Promise<CallToolResult> => {
      if (!delegateUser) {
        return { content: [{ type: "text", text: "Unauthorized" }], isError: true };
      }

      const rows = await listDelegateNamespaces(db, delegateUser);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ namespaces: rows }),
          },
        ],
      };
    },
  );

  server.registerTool(
    "recall",
    {
      title: "Recall thread",
      description: "Fetches ordered messages and file references for a namespace captured from a Slack thread",
      inputSchema: {
        namespaceId: z.string().uuid().describe("Namespace ID returned when the bot captured the thread"),
      },
    },
    async ({ namespaceId }): Promise<CallToolResult> => {
      if (!delegateUser) {
        return { content: [{ type: "text", text: "Unauthorized" }], isError: true };
      }

      const result = await recallNamespace(db, delegateUser, namespaceId);
      if (!result.authorized) {
        return { content: [{ type: "text", text: "Not authorized to recall this namespace" }], isError: true };
      }

      // Fire-and-forget: this is the one place in the codebase where a DB write is intentionally
      // NOT awaited inline. A logging failure (e.g. a transient DB error) must never delay or
      // fail the recall response — do not "fix" this into a blocking `await`.
      logRecallEvent(db, result.namespaceId, delegateUser.id).catch((err) => {
        console.error("Failed to log recall event:", err);
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ namespaceId: result.namespaceId, messages: result.messages }),
          },
        ],
      };
    },
  );

  server.registerTool(
    "memory_plan",
    {
      title: "Generate plan from memory",
      description: "Recalls a namespace and formats the captured memory into an implementation plan",
      inputSchema: {
        namespaceId: z.string().uuid().describe("Namespace ID returned when the bot captured the thread"),
      },
    },
    async ({ namespaceId }): Promise<CallToolResult> => {
      if (!delegateUser) {
        return { content: [{ type: "text", text: "Unauthorized" }], isError: true };
      }

      const result = await recallNamespace(db, delegateUser, namespaceId);
      if (!result.authorized) {
        return { content: [{ type: "text", text: "Not authorized to recall this namespace" }], isError: true };
      }

      return { content: [{ type: "text", text: buildMemoryPlan(result.messages) }] };
    },
  );

  server.registerTool(
    "memory_checklist",
    {
      title: "Generate checklist from memory",
      description: "Recalls a namespace and formats the captured memory into a verification checklist",
      inputSchema: {
        namespaceId: z.string().uuid().describe("Namespace ID returned when the bot captured the thread"),
      },
    },
    async ({ namespaceId }): Promise<CallToolResult> => {
      if (!delegateUser) {
        return { content: [{ type: "text", text: "Unauthorized" }], isError: true };
      }

      const result = await recallNamespace(db, delegateUser, namespaceId);
      if (!result.authorized) {
        return { content: [{ type: "text", text: "Not authorized to recall this namespace" }], isError: true };
      }

      return { content: [{ type: "text", text: buildMemoryChecklist(result.messages) }] };
    },
  );

  server.registerTool(
    "verify_blob",
    {
      title: "Verify Walrus message blob",
      description: "Reads a message's Walrus blob through the configured aggregator and reports whether it is available",
      inputSchema: {
        namespaceId: z.string().uuid().describe("Namespace ID returned when the bot captured the thread"),
        messageId: z.string().uuid().describe("Message ID from the recall response"),
      },
    },
    async ({ namespaceId, messageId }): Promise<CallToolResult> => {
      if (!delegateUser) {
        return { content: [{ type: "text", text: "Unauthorized" }], isError: true };
      }

      const result = await verifyWalrusMessageBlob(db, delegateUser, namespaceId, messageId);
      if (!result.authorized) {
        return { content: [{ type: "text", text: "Not authorized to verify this blob" }], isError: true };
      }

      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  );

  return server;
}

const METHOD_NOT_ALLOWED_BODY = JSON.stringify({
  jsonrpc: "2.0",
  error: { code: -32000, message: "Method not allowed." },
  id: null,
});

export function mountMcpServer(app: Express, db: Database): void {
  const auth = requireDelegateKey(db);

  app.post("/mcp", auth, async (req: AuthedRequest, res: Response) => {
    const server = buildRecallServer(db, req.delegateUser);
    try {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      res.on("close", () => {
        transport.close();
        server.close();
      });
    } catch (error) {
      console.error("Error handling MCP request:", error);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
      }
    }
  });

  app.get("/mcp", auth, (_req: Request, res: Response) => {
    res.writeHead(405).end(METHOD_NOT_ALLOWED_BODY);
  });

  app.delete("/mcp", auth, (_req: Request, res: Response) => {
    res.writeHead(405).end(METHOD_NOT_ALLOWED_BODY);
  });
}
