import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/client.js";
import { workspaces, users } from "../../src/db/schema.js";
import { issueDelegateKey } from "../../src/slack/recallKeyCommand.js";
import { hashDelegateKey } from "../../src/keys/delegateKeys.js";

describe("issueDelegateKey", () => {
  it("creates a user row with a hashed key and returns the plaintext once", async () => {
    const [workspace] = await db.insert(workspaces).values({ slackTeamId: "T1", name: "T" }).returning();

    const plaintext = await issueDelegateKey(db, workspace.id, "U100");

    expect(plaintext).toMatch(/^rk_/);
    const [user] = await db.select().from(users).where(eq(users.slackUserId, "U100"));
    expect(user.delegateKeyHash).toBe(hashDelegateKey(plaintext));
  });

  it("rotates the key (and hash) when called again for the same user", async () => {
    const [workspace] = await db.insert(workspaces).values({ slackTeamId: "T2", name: "T" }).returning();

    const first = await issueDelegateKey(db, workspace.id, "U200");
    const second = await issueDelegateKey(db, workspace.id, "U200");

    expect(second).not.toBe(first);
    const rows = await db.select().from(users).where(eq(users.slackUserId, "U200"));
    expect(rows).toHaveLength(1);
    expect(rows[0].delegateKeyHash).toBe(hashDelegateKey(second));
  });
});
