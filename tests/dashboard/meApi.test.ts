import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import { db } from "../../src/db/client.js";
import { workspaces, installations, namespaces, messages } from "../../src/db/schema.js";
import { issueUserClaimToken } from "../../src/dashboard/userClaimTokens.js";
import { createMeApiRouter } from "../../src/dashboard/meApi.js";

vi.mock("@slack/web-api", () => ({
  WebClient: vi.fn().mockImplementation(() => ({
    users: { info: vi.fn().mockRejectedValue({ data: { error: "missing_scope" } }) },
  })),
}));

const SECRET = "test-secret-at-least-this-long";

function buildTestApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/me", createMeApiRouter(db, SECRET));
  return app;
}

async function seedWorkspace(teamId: string) {
  const [workspace] = await db.insert(workspaces).values({ slackTeamId: teamId, name: `Team ${teamId}` }).returning();
  await db.insert(installations).values({ workspaceId: workspace.id, botToken: "xoxb-fake", botUserId: "UBOT" });
  return workspace;
}

async function claimSessionCookie(app: express.Express, workspaceId: string, slackUserId: string) {
  const token = await issueUserClaimToken(db, workspaceId, slackUserId);
  const res = await request(app).post("/api/me/claim").send({ token });
  const setCookie = res.headers["set-cookie"];
  expect(setCookie).toBeDefined();
  return (setCookie as unknown as string[])[0].split(";")[0];
}

describe("personal (/api/me) API", () => {
  it("POST /claim sets a session cookie for a valid token, and rejects reuse", async () => {
    const app = buildTestApp();
    const workspace = await seedWorkspace("M1");
    const token = await issueUserClaimToken(db, workspace.id, "U1");

    const first = await request(app).post("/api/me/claim").send({ token });
    expect(first.status).toBe(200);
    expect(first.headers["set-cookie"]).toBeDefined();

    const second = await request(app).post("/api/me/claim").send({ token });
    expect(second.status).toBe(400);
  });

  it("rejects every protected route with no cookie", async () => {
    const app = buildTestApp();
    expect((await request(app).get("/api/me/me")).status).toBe(401);
    expect((await request(app).get("/api/me/namespaces")).status).toBe(401);
    expect((await request(app).get(`/api/me/namespaces/${crypto.randomUUID()}/messages`)).status).toBe(401);
    expect((await request(app).post("/api/me/logout")).status).toBe(401);
  });

  it("GET /namespaces lists only namespaces the session's slackUserId participated in, never another user's or another workspace's", async () => {
    const app = buildTestApp();
    const workspace = await seedWorkspace("M2");
    const otherWorkspace = await seedWorkspace("M2-OTHER");

    const [shared] = await db.insert(namespaces).values({ workspaceId: workspace.id, channelId: "C1", threadTs: "1.0" }).returning();
    const [mineOnly] = await db.insert(namespaces).values({ workspaceId: workspace.id, channelId: "C2", threadTs: "2.0" }).returning();
    const [theirsOnly] = await db.insert(namespaces).values({ workspaceId: workspace.id, channelId: "C3", threadTs: "3.0" }).returning();
    const [otherWorkspaceNs] = await db
      .insert(namespaces)
      .values({ workspaceId: otherWorkspace.id, channelId: "C4", threadTs: "4.0" })
      .returning();

    await db.insert(messages).values([
      { namespaceId: shared.id, slackUserId: "U1", text: "hi", slackTs: "1.0" },
      { namespaceId: shared.id, slackUserId: "U2", text: "hi back", slackTs: "1.1" },
      { namespaceId: mineOnly.id, slackUserId: "U1", text: "solo", slackTs: "2.0" },
      { namespaceId: theirsOnly.id, slackUserId: "U2", text: "not yours", slackTs: "3.0" },
      { namespaceId: otherWorkspaceNs.id, slackUserId: "U1", text: "wrong workspace", slackTs: "4.0" },
    ]);

    const cookie = await claimSessionCookie(app, workspace.id, "U1");
    const res = await request(app).get("/api/me/namespaces").set("Cookie", cookie);
    expect(res.status).toBe(200);
    const ids = res.body.map((n: { id: string }) => n.id).sort();
    expect(ids).toEqual([shared.id, mineOnly.id].sort());
    expect(ids).not.toContain(theirsOnly.id);
    expect(ids).not.toContain(otherWorkspaceNs.id);
  });

  it("GET /namespaces/:id/messages 404s for a namespace in the same workspace the caller never participated in", async () => {
    const app = buildTestApp();
    const workspace = await seedWorkspace("M3");
    const [theirsOnly] = await db.insert(namespaces).values({ workspaceId: workspace.id, channelId: "C1", threadTs: "1.0" }).returning();
    await db.insert(messages).values({ namespaceId: theirsOnly.id, slackUserId: "U2", text: "not yours", slackTs: "1.0" });

    const cookie = await claimSessionCookie(app, workspace.id, "U1");
    const res = await request(app).get(`/api/me/namespaces/${theirsOnly.id}/messages`).set("Cookie", cookie);
    expect(res.status).toBe(404);
  });

  it("GET /namespaces/:id/messages 404s for a namespace in a different workspace", async () => {
    const app = buildTestApp();
    const workspace = await seedWorkspace("M4");
    const otherWorkspace = await seedWorkspace("M4-OTHER");
    const [otherNs] = await db.insert(namespaces).values({ workspaceId: otherWorkspace.id, channelId: "C1", threadTs: "1.0" }).returning();
    await db.insert(messages).values({ namespaceId: otherNs.id, slackUserId: "U1", text: "hi", slackTs: "1.0" });

    const cookie = await claimSessionCookie(app, workspace.id, "U1");
    const res = await request(app).get(`/api/me/namespaces/${otherNs.id}/messages`).set("Cookie", cookie);
    expect(res.status).toBe(404);
  });

  it("GET /namespaces/:id/messages 404s for a malformed id instead of 500ing", async () => {
    const app = buildTestApp();
    const workspace = await seedWorkspace("M5");
    const cookie = await claimSessionCookie(app, workspace.id, "U1");
    const res = await request(app).get("/api/me/namespaces/not-a-uuid/messages").set("Cookie", cookie);
    expect(res.status).toBe(404);
  });

  it("GET /namespaces/:id/messages 200s with the full shape for an actual participant", async () => {
    const app = buildTestApp();
    const workspace = await seedWorkspace("M6");
    const [ns] = await db.insert(namespaces).values({ workspaceId: workspace.id, channelId: "C1", threadTs: "1.0" }).returning();
    await db.insert(messages).values({ namespaceId: ns.id, slackUserId: "U1", text: "hi", slackTs: "1.0" });

    const cookie = await claimSessionCookie(app, workspace.id, "U1");
    const res = await request(app).get(`/api/me/namespaces/${ns.id}/messages`).set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.messages).toHaveLength(1);
    expect(res.body.messages[0].text).toBe("hi");
    expect(res.body).toHaveProperty("linearIssues");
  });

  it("GET /me returns only the session's own identity, no admin-only fields", async () => {
    const app = buildTestApp();
    const workspace = await seedWorkspace("M7");
    await db.insert(namespaces).values({ workspaceId: workspace.id, channelId: "C1", threadTs: "1.0" }).returning();

    const cookie = await claimSessionCookie(app, workspace.id, "U1");
    const res = await request(app).get("/api/me/me").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ slackUserId: "U1", displayName: null });
  });
});
