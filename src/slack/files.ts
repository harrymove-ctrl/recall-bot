import { eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { files } from "../db/schema.js";
import { putFile } from "../storage/bucket.js";

export interface SlackFileObject {
  id: string;
  name: string;
  mimetype: string;
  url_private: string;
}

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

  const [fileRow] = await db
    .insert(files)
    .values({ messageId, originalName: file.name, mimeType: file.mimetype, status: "pending" })
    .returning();

  try {
    const bytes = await downloadSlackFile(file.url_private, botToken);
    const bucketKey = `messages/${messageId}/${file.id}-${file.name}`;
    await putFile(bucketKey, bytes, file.mimetype);
    await db.update(files).set({ bucketKey, status: "stored" }).where(eq(files.id, fileRow.id));
  } catch {
    await db.update(files).set({ status: "failed" }).where(eq(files.id, fileRow.id));
  }
}
