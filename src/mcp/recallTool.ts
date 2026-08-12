import { and, asc, desc, eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { messages, namespaces, messageMentions } from "../db/schema.js";
import { findParticipantNamespace } from "../db/participation.js";
import { getSignedDownloadUrl } from "../storage/bucket.js";
import { readWalrusBlob } from "../storage/walrusMemory.js";
import type { DelegateUser } from "./auth.js";

export interface RecallFile {
  originalName: string;
  url: string | null;
  status: string;
  walrusBlobId: string | null;
  walrusStorageStatus: string;
}

export interface RecallMessage {
  slackUserId: string;
  text: string;
  slackTs: string;
  walrusBlobId: string | null;
  walrusBlobObjectId: string | null;
  walrusTxDigest: string | null;
  walrusEndEpoch: string | null;
  walrusStorageStatus: string;
  contentSource: "walrus" | "postgres_cache";
  walrusVerified: boolean;
  files: RecallFile[];
}

export type RecallResult =
  | { authorized: true; namespaceId: string; messages: RecallMessage[] }
  | { authorized: false };

export interface DelegateNamespace {
  id: string;
  channelId: string;
  threadTs: string;
  label: string | null;
  status: string;
  createdAt: Date;
}

export async function listDelegateNamespaces(db: Database, delegateUser: DelegateUser): Promise<DelegateNamespace[]> {
  // Namespace IDs where the user authored a message
  const authoredRows = await db
    .selectDistinct({ namespaceId: messages.namespaceId })
    .from(messages)
    .innerJoin(namespaces, eq(messages.namespaceId, namespaces.id))
    .where(and(eq(namespaces.workspaceId, delegateUser.workspaceId), eq(messages.slackUserId, delegateUser.slackUserId)));

  // Namespace IDs where the user was @mentioned in any message
  const mentionedRows = await db
    .selectDistinct({ namespaceId: messages.namespaceId })
    .from(messageMentions)
    .innerJoin(messages, eq(messageMentions.messageId, messages.id))
    .innerJoin(namespaces, eq(messages.namespaceId, namespaces.id))
    .where(and(eq(namespaces.workspaceId, delegateUser.workspaceId), eq(messageMentions.slackUserId, delegateUser.slackUserId)));

  const allNamespaceIds = [...authoredRows, ...mentionedRows]
    .map((r) => r.namespaceId)
    .filter((id): id is string => Boolean(id));

  if (allNamespaceIds.length === 0) return [];

  const uniqueIds = [...new Set(allNamespaceIds)];

  const rows = await db
    .select()
    .from(namespaces)
    .where(eq(namespaces.workspaceId, delegateUser.workspaceId))
    .orderBy(desc(namespaces.createdAt));

  return rows.filter((n) => uniqueIds.includes(n.id));
}

function decodeWalrusMemory(bytes: Uint8Array): string | null {
  const text = new TextDecoder().decode(bytes);
  try {
    const payload = JSON.parse(text) as { content?: { text?: unknown } };
    return typeof payload.content?.text === "string" ? payload.content.text : text;
  } catch {
    return text;
  }
}

async function readMessageTextFromWalrus(blobId: string | null): Promise<{ text: string | null; verified: boolean }> {
  if (!blobId) return { text: null, verified: false };
  const bytes = await readWalrusBlob(blobId);
  if (!bytes) return { text: null, verified: false };
  return { text: decodeWalrusMemory(bytes), verified: true };
}

export async function recallNamespace(
  db: Database,
  delegateUser: DelegateUser,
  namespaceId: string,
): Promise<RecallResult> {
  const namespace = await findParticipantNamespace(db, delegateUser.workspaceId, delegateUser.slackUserId, namespaceId);
  if (!namespace) return { authorized: false };

  const rows = await db.query.messages.findMany({
    where: eq(messages.namespaceId, namespace.id),
    orderBy: asc(messages.slackTs),
    with: { files: true },
  });

  const result: RecallMessage[] = [];
  for (const row of rows) {
    const fileRefs: RecallFile[] = [];
    for (const file of row.files) {
      const url = file.status === "stored" && file.bucketKey ? await getSignedDownloadUrl(file.bucketKey) : null;
      fileRefs.push({
        originalName: file.originalName,
        url,
        status: file.status,
        walrusBlobId: file.walrusBlobId,
        walrusStorageStatus: file.walrusStorageStatus,
      });
    }
    let walrusText: string | null = null;
    let walrusVerified = false;
    try {
      const walrus = await readMessageTextFromWalrus(row.walrusBlobId);
      walrusText = walrus.text;
      walrusVerified = walrus.verified;
    } catch (error) {
      console.error(`recallNamespace: failed to read Walrus blob for message ${row.id}:`, error);
    }
    result.push({
      slackUserId: row.slackUserId,
      text: walrusText ?? row.text,
      slackTs: row.slackTs,
      walrusBlobId: row.walrusBlobId,
      walrusBlobObjectId: row.walrusBlobObjectId,
      walrusTxDigest: row.walrusTxDigest,
      walrusEndEpoch: row.walrusEndEpoch,
      walrusStorageStatus: row.walrusStorageStatus,
      contentSource: walrusText === null ? "postgres_cache" : "walrus",
      walrusVerified,
      files: fileRefs,
    });
  }

  return { authorized: true, namespaceId: namespace.id, messages: result };
}

export async function verifyWalrusMessageBlob(
  db: Database,
  delegateUser: DelegateUser,
  namespaceId: string,
  messageId: string,
): Promise<
  | { authorized: true; messageId: string; walrusBlobId: string | null; verified: boolean; contentLength: number | null }
  | { authorized: false }
> {
  const namespace = await findParticipantNamespace(db, delegateUser.workspaceId, delegateUser.slackUserId, namespaceId);
  if (!namespace) return { authorized: false };

  const [row] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.id, messageId), eq(messages.namespaceId, namespace.id)));
  if (!row) return { authorized: false };

  const bytes = row.walrusBlobId ? await readWalrusBlob(row.walrusBlobId) : null;
  return {
    authorized: true,
    messageId: row.id,
    walrusBlobId: row.walrusBlobId,
    verified: Boolean(bytes),
    contentLength: bytes?.byteLength ?? null,
  };
}

export function buildMemoryPlan(messages: RecallMessage[]): string {
  const usableMessages = messages.filter((m) => m.text.trim().length > 0);
  const sourceLine = `Source: ${messages.length} recalled messages, ${messages.filter((m) => m.walrusStorageStatus === "stored").length} Walrus-backed.`;
  const context = usableMessages.slice(0, 8).map((m, index) => `${index + 1}. ${m.text.trim()}`);
  return [
    "# Memory Plan",
    "",
    sourceLine,
    "",
    "## Context pulled from memory",
    ...(context.length > 0 ? context : ["No message text was captured."]),
    "",
    "## Suggested plan",
    "1. Identify the concrete goal from the recalled thread.",
    "2. Extract decisions, constraints, and open questions.",
    "3. Turn each actionable request into an implementation task.",
    "4. Verify work against the original recalled context before shipping.",
  ].join("\n");
}

export function buildMemoryChecklist(messages: RecallMessage[]): string {
  const walrusMissing = messages.filter((m) => m.walrusStorageStatus !== "stored").length;
  return [
    "# Memory Checklist",
    "",
    `- [ ] Review ${messages.length} recalled message${messages.length === 1 ? "" : "s"}.`,
    `- [ ] Confirm ${messages.length - walrusMissing} message${messages.length - walrusMissing === 1 ? "" : "s"} have Walrus blob IDs.`,
    ...(walrusMissing > 0 ? [`- [ ] Backfill or retry ${walrusMissing} message${walrusMissing === 1 ? "" : "s"} not stored on Walrus.`] : []),
    "- [ ] Capture the user's intended outcome.",
    "- [ ] List implementation tasks.",
    "- [ ] Verify the finished work against the recalled thread.",
  ].join("\n");
}
