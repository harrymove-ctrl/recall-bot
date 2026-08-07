import { and, eq } from "drizzle-orm";
import type { Database } from "./client.js";
import { namespaces, messages } from "./schema.js";

/**
 * The single source of truth for "does this Slack user have standing to see this namespace."
 * A namespace is visible to a user only if (a) it belongs to their workspace and (b) they have
 * at least one message row in it — matching who actually participated in the captured thread,
 * not just anyone in the workspace. Both the MCP recall tool (src/mcp/recallTool.ts) and the
 * personal dashboard API (src/dashboard/meApi.ts) call this exact function so the authorization
 * check can never drift between the two surfaces.
 */
export async function findParticipantNamespace(
  db: Database,
  workspaceId: string,
  slackUserId: string,
  namespaceId: string,
): Promise<{ id: string } | null> {
  const [namespace] = await db
    .select({ id: namespaces.id })
    .from(namespaces)
    .where(and(eq(namespaces.id, namespaceId), eq(namespaces.workspaceId, workspaceId)));
  if (!namespace) return null;

  const [participation] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.namespaceId, namespace.id), eq(messages.slackUserId, slackUserId)));
  if (!participation) return null;

  return namespace;
}
