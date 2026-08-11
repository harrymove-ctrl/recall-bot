import { and, asc, desc, eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { messages, namespaces } from "../db/schema.js";
import { findParticipantNamespace } from "../db/participation.js";
import { getSignedDownloadUrl } from "../storage/bucket.js";
import type { DelegateUser } from "./auth.js";

export interface RecallFile {
  originalName: string;
  url: string | null;
  status: string;
}

export interface RecallMessage {
  slackUserId: string;
  text: string;
  slackTs: string;
  walrusBlobId: string | null;
  walrusStorageStatus: string;
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
  const participantRows = await db
    .selectDistinct({ namespaceId: messages.namespaceId })
    .from(messages)
    .innerJoin(namespaces, eq(messages.namespaceId, namespaces.id))
    .where(and(eq(namespaces.workspaceId, delegateUser.workspaceId), eq(messages.slackUserId, delegateUser.slackUserId)));

  const participantIds = new Set(
    participantRows
      .filter((row) => row.namespaceId)
      .map((row) => row.namespaceId),
  );

  if (participantIds.size === 0) return [];

  const allRows = await db
    .select()
    .from(namespaces)
    .where(eq(namespaces.workspaceId, delegateUser.workspaceId))
    .orderBy(desc(namespaces.createdAt));

  const visible: DelegateNamespace[] = [];
  for (const namespace of allRows) {
    if (!participantIds.has(namespace.id)) continue;
    const [participation] = await db
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.namespaceId, namespace.id), eq(messages.slackUserId, delegateUser.slackUserId)));
    if (!participation) continue;
    visible.push(namespace);
  }

  return visible;
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
      fileRefs.push({ originalName: file.originalName, url, status: file.status });
    }
    result.push({
      slackUserId: row.slackUserId,
      text: row.text,
      slackTs: row.slackTs,
      walrusBlobId: row.walrusBlobId,
      walrusStorageStatus: row.walrusStorageStatus,
      files: fileRefs,
    });
  }

  return { authorized: true, namespaceId: namespace.id, messages: result };
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
