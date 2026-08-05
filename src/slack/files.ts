import { eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { files } from "../db/schema.js";
import { putFile } from "../storage/bucket.js";

export interface SlackFileObject {
  id: string;
  name: string;
  mimetype: string;
  url_private: string;
  /** Byte size Slack reports for the upload; used to reject files too large to buffer. */
  size: number;
}

/**
 * Slack accepts uploads of up to 1GB, and downloadSlackFile buffers the whole response in memory
 * before it is streamed to the bucket. This is a single process that also serves Slack events and
 * MCP requests, so one large attachment would take everything down with it. Files above this are
 * recorded as failed without a download attempt rather than risking the process.
 */
export const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024;

export async function downloadSlackFile(url: string, botToken: string): Promise<Buffer> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${botToken}` },
  });
  if (!res.ok) {
    throw new Error(`Slack file download failed: ${res.status} ${res.statusText}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

export interface CaptureSlackFileParams {
  db: Database;
  file: SlackFileObject;
  botToken: string;
  messageId: string;
}

export async function captureSlackFile(params: CaptureSlackFileParams): Promise<void> {
  const { db, file, botToken, messageId } = params;

  // `>` (not `>=`) so a file exactly at the limit is still captured. If Slack omits `size`
  // entirely the comparison is false and we fall through to the normal download path.
  if (file.size > MAX_FILE_SIZE_BYTES) {
    console.error(
      `captureSlackFile: skipping oversize Slack file ${file.id} (${file.name}) for message ${messageId}: ` +
        `${file.size} bytes exceeds the ${MAX_FILE_SIZE_BYTES} byte limit`,
    );
    await db.insert(files).values({ messageId, originalName: file.name, mimeType: file.mimetype, status: "failed" });
    return;
  }

  const [fileRow] = await db
    .insert(files)
    .values({ messageId, originalName: file.name, mimeType: file.mimetype, status: "pending" })
    .returning();

  try {
    const bytes = await downloadSlackFile(file.url_private, botToken);
    const bucketKey = `messages/${messageId}/${file.id}-${file.name}`;
    await putFile(bucketKey, bytes, file.mimetype);
    await db.update(files).set({ bucketKey, status: "stored" }).where(eq(files.id, fileRow.id));
  } catch (error) {
    // Capture failures are swallowed on purpose (one bad attachment must not abort a backfill),
    // so this log is the only signal that anything went wrong — it has to carry enough to
    // identify the row: the Slack file id, its name, and the message it belongs to.
    console.error(
      `captureSlackFile: failed to capture Slack file ${file.id} (${file.name}) for message ${messageId}:`,
      error,
    );
    await db.update(files).set({ status: "failed" }).where(eq(files.id, fileRow.id));
  }
}
