import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { workspaceClaimTokens } from "../db/schema.js";

const DEFAULT_EXPIRY_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

function hashToken(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

export async function issueClaimToken(
  db: Database,
  workspaceId: string,
  expiryMs: number = DEFAULT_EXPIRY_MS,
): Promise<string> {
  const plaintext = randomBytes(24).toString("hex");
  await db.insert(workspaceClaimTokens).values({
    workspaceId,
    tokenHash: hashToken(plaintext),
    expiresAt: new Date(Date.now() + expiryMs),
  });
  return plaintext;
}

export async function consumeClaimToken(db: Database, plaintext: string): Promise<{ workspaceId: string } | null> {
  const [row] = await db
    .select()
    .from(workspaceClaimTokens)
    .where(eq(workspaceClaimTokens.tokenHash, hashToken(plaintext)));

  if (!row) return null;
  if (row.usedAt) return null;
  if (row.expiresAt.getTime() < Date.now()) return null;

  await db.update(workspaceClaimTokens).set({ usedAt: new Date() }).where(eq(workspaceClaimTokens.id, row.id));

  return { workspaceId: row.workspaceId };
}
