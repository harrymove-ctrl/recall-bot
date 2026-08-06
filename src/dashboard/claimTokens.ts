import { createHash, randomBytes } from "node:crypto";
import { eq, and, isNull, gt } from "drizzle-orm";
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
    .update(workspaceClaimTokens)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(workspaceClaimTokens.tokenHash, hashToken(plaintext)),
        isNull(workspaceClaimTokens.usedAt),
        gt(workspaceClaimTokens.expiresAt, new Date()),
      ),
    )
    .returning();

  return row ? { workspaceId: row.workspaceId } : null;
}
