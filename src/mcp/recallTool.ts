import { and, asc, eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { namespaces, messages } from "../db/schema.js";
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
  files: RecallFile[];
}

export type RecallResult =
  | { authorized: true; namespaceId: string; messages: RecallMessage[] }
  | { authorized: false };

export async function recallNamespace(
  db: Database,
  delegateUser: DelegateUser,
  namespaceId: string,
): Promise<RecallResult> {
  const [namespace] = await db
    .select()
    .from(namespaces)
    .where(and(eq(namespaces.id, namespaceId), eq(namespaces.workspaceId, delegateUser.workspaceId)));
  if (!namespace) return { authorized: false };

  const [participation] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.namespaceId, namespace.id), eq(messages.slackUserId, delegateUser.slackUserId)));
  if (!participation) return { authorized: false };

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
    result.push({ slackUserId: row.slackUserId, text: row.text, slackTs: row.slackTs, files: fileRefs });
  }

  return { authorized: true, namespaceId: namespace.id, messages: result };
}
