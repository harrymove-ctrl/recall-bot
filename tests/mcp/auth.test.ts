import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { db } from "../../src/db/client.js";
import { workspaces, users } from "../../src/db/schema.js";
import { requireDelegateKey, type AuthedRequest } from "../../src/mcp/auth.js";
import { hashDelegateKey } from "../../src/keys/delegateKeys.js";

function buildTestApp() {
  const app = express();
  app.get("/protected", requireDelegateKey(db), (req: AuthedRequest, res) => {
    res.json({ delegateUser: req.delegateUser });
  });
  return app;
}

describe("requireDelegateKey", () => {
  it("returns 401 when no Authorization header is present", async () => {
    const res = await request(buildTestApp()).get("/protected");
    expect(res.status).toBe(401);
  });

  it("returns 401 for a well-formed but unknown key", async () => {
    const res = await request(buildTestApp()).get("/protected").set("Authorization", "Bearer rk_doesnotexist");
    expect(res.status).toBe(401);
  });

  it("attaches delegateUser and calls next for a valid key", async () => {
    const [workspace] = await db.insert(workspaces).values({ slackTeamId: "T1", name: "T" }).returning();
    const plaintext = "rk_testkey1234567890";
    const [user] = await db
      .insert(users)
      .values({ workspaceId: workspace.id, slackUserId: "U1", delegateKeyHash: hashDelegateKey(plaintext) })
      .returning();

    const res = await request(buildTestApp()).get("/protected").set("Authorization", `Bearer ${plaintext}`);

    expect(res.status).toBe(200);
    expect(res.body.delegateUser).toEqual({ id: user.id, workspaceId: workspace.id, slackUserId: "U1" });
  });
});
