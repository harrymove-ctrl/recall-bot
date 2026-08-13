import { createHash, randomBytes } from "node:crypto";
import { eq, and, isNull, gt } from "drizzle-orm";
import { userClaimTokens } from "../db/schema.js";
const DEFAULT_EXPIRY_MS = 1000 * 60 * 60 * 24 * 7; // 7 days — matches workspace claim tokens
function hashToken(plaintext) {
    return createHash("sha256").update(plaintext).digest("hex");
}
export async function issueUserClaimToken(db, workspaceId, slackUserId, expiryMs = DEFAULT_EXPIRY_MS) {
    const plaintext = randomBytes(24).toString("hex");
    await db.insert(userClaimTokens).values({
        workspaceId,
        slackUserId,
        tokenHash: hashToken(plaintext),
        expiresAt: new Date(Date.now() + expiryMs),
    });
    return plaintext;
}
export async function consumeUserClaimToken(db, plaintext) {
    const [row] = await db
        .update(userClaimTokens)
        .set({ usedAt: new Date() })
        .where(and(eq(userClaimTokens.tokenHash, hashToken(plaintext)), isNull(userClaimTokens.usedAt), gt(userClaimTokens.expiresAt, new Date())))
        .returning();
    return row ? { workspaceId: row.workspaceId, slackUserId: row.slackUserId } : null;
}
//# sourceMappingURL=userClaimTokens.js.map