import { and, eq } from "drizzle-orm";
import type { Database } from "./client.js";
import { namespaces, messages, messageMentions } from "./schema.js";

/**
 * The single source of truth for "does this Slack user have standing to see this namespace."
 * A namespace is visible to a user only if (a) it belongs to their workspace and (b) they either
 * authored a message in it OR were @mentioned in any message in the thread.
 * Both the MCP recall tool (src/mcp/recallTool.ts) and the personal dashboard API
 * (src/dashboard/meApi.ts) call this exact function so the authorization check can never drift.
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

  // User authored a message in this namespace
  const [authored] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.namespaceId, namespace.id), eq(messages.slackUserId, slackUserId)));
  if (authored) return namespace;

  // User was @mentioned in any message in this namespace
  const [mentioned] = await db
    .select({ id: messageMentions.id })
    .from(messageMentions)
    .innerJoin(messages, eq(messageMentions.messageId, messages.id))
    .where(and(eq(messages.namespaceId, namespace.id), eq(messageMentions.slackUserId, slackUserId)));
  if (mentioned) return namespace;

  return null;
}
