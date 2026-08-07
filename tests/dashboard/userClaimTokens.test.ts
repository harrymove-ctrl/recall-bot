import { describe, it, expect } from "vitest";
import { db } from "../../src/db/client.js";
import { workspaces } from "../../src/db/schema.js";
import { issueUserClaimToken, consumeUserClaimToken } from "../../src/dashboard/userClaimTokens.js";

describe("issueUserClaimToken / consumeUserClaimToken", () => {
  it("issues a token that can be consumed exactly once", async () => {
    const [workspace] = await db.insert(workspaces).values({ slackTeamId: "T1", name: "T" }).returning();

    const plaintext = await issueUserClaimToken(db, workspace.id, "U100");
    expect(typeof plaintext).toBe("string");
    expect(plaintext.length).toBeGreaterThan(20);

    const first = await consumeUserClaimToken(db, plaintext);
    expect(first).toEqual({ workspaceId: workspace.id, slackUserId: "U100" });

    const second = await consumeUserClaimToken(db, plaintext);
    expect(second).toBeNull();
  });

  it("rejects an unknown token", async () => {
    const result = await consumeUserClaimToken(db, "this-token-was-never-issued");
    expect(result).toBeNull();
  });

  it("rejects an expired token", async () => {
    const [workspace] = await db.insert(workspaces).values({ slackTeamId: "T2", name: "T" }).returning();
    const plaintext = await issueUserClaimToken(db, workspace.id, "U200", -1000);
    const result = await consumeUserClaimToken(db, plaintext);
    expect(result).toBeNull();
  });

  it("only allows one of two concurrent consumers to succeed", async () => {
    const [workspace] = await db.insert(workspaces).values({ slackTeamId: "T3", name: "T" }).returning();
    const plaintext = await issueUserClaimToken(db, workspace.id, "U300");

    const [first, second] = await Promise.all([consumeUserClaimToken(db, plaintext), consumeUserClaimToken(db, plaintext)]);
    const results = [first, second];
    expect(results.filter((r) => r !== null)).toHaveLength(1);
    expect(results.filter((r) => r === null)).toHaveLength(1);
  });
});
