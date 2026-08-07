import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/client.js";
import { workspaces, users } from "../../src/db/schema.js";
import { issueDelegateKey, issuePersonalLoginLink } from "../../src/slack/recallKeyCommand.js";
import { hashDelegateKey } from "../../src/keys/delegateKeys.js";
import { consumeUserClaimToken } from "../../src/dashboard/userClaimTokens.js";

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

describe("issuePersonalLoginLink", () => {
  it("returns a claim URL whose token round-trips to the right workspace and user", async () => {
    const [workspace] = await db.insert(workspaces).values({ slackTeamId: "T3", name: "T" }).returning();

    const link = await issuePersonalLoginLink(db, workspace.id, "U300", "https://example.up.railway.app");

    expect(link).toMatch(/^https:\/\/example\.up\.railway\.app\/dashboard\/me\/claim\?token=/);
    const token = new URL(link).searchParams.get("token")!;
    const result = await consumeUserClaimToken(db, token);
    expect(result).toEqual({ workspaceId: workspace.id, slackUserId: "U300" });
  });
});
