import { describe, it, expect } from "vitest";
import { db } from "../../src/db/client.js";
import { workspaces } from "../../src/db/schema.js";
import { issueClaimToken, consumeClaimToken } from "../../src/dashboard/claimTokens.js";

describe("issueClaimToken / consumeClaimToken", () => {
  it("issues a token that can be consumed exactly once", async () => {
    const [workspace] = await db.insert(workspaces).values({ slackTeamId: "T1", name: "T" }).returning();

    const plaintext = await issueClaimToken(db, workspace.id);
    expect(typeof plaintext).toBe("string");
    expect(plaintext.length).toBeGreaterThan(20);

    const first = await consumeClaimToken(db, plaintext);
    expect(first).toEqual({ workspaceId: workspace.id });

    const second = await consumeClaimToken(db, plaintext);
    expect(second).toBeNull();
  });

  it("rejects an unknown token", async () => {
    const result = await consumeClaimToken(db, "this-token-was-never-issued");
    expect(result).toBeNull();
  });

  it("rejects an expired token", async () => {
    const [workspace] = await db.insert(workspaces).values({ slackTeamId: "T2", name: "T" }).returning();
    const plaintext = await issueClaimToken(db, workspace.id, -1000);
    const result = await consumeClaimToken(db, plaintext);
    expect(result).toBeNull();
  });
});
