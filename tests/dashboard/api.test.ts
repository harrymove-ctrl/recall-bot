import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/client.js";
import {
  workspaces,
  installations,
  namespaces,
  users,
  messages,
  files,
  namespaceLinearIssues,
  slackUserProfiles,
} from "../../src/db/schema.js";
import { issueClaimToken } from "../../src/dashboard/claimTokens.js";
import { hashDelegateKey } from "../../src/keys/delegateKeys.js";
import { createDashboardApiRouter } from "../../src/dashboard/api.js";

vi.mock("@slack/web-api", () => ({
  WebClient: vi.fn().mockImplementation(() => ({
    users: { info: vi.fn().mockRejectedValue({ data: { error: "missing_scope" } }) },
  })),
}));

const SECRET = "test-secret-at-least-this-long";

function buildTestApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/dashboard", createDashboardApiRouter(db, SECRET));
  return app;
}

async function seedWorkspace(teamId: string) {
  const [workspace] = await db.insert(workspaces).values({ slackTeamId: teamId, name: `Team ${teamId}` }).returning();
  await db.insert(installations).values({ workspaceId: workspace.id, botToken: "xoxb-fake", botUserId: "UBOT" });
  return workspace;
}

async function claimSessionCookie(app: express.Express, workspaceId: string) {
  const token = await issueClaimToken(db, workspaceId);
  const res = await request(app).post("/api/dashboard/claim").send({ token });
  const setCookie = res.headers["set-cookie"];
  expect(setCookie).toBeDefined();
  return (setCookie as unknown as string[])[0].split(";")[0];
}

describe("dashboard API", () => {
  it("POST /claim sets a session cookie for a valid token, and rejects reuse", async () => {
    const app = buildTestApp();
    const workspace = await seedWorkspace("T1");
    const token = await issueClaimToken(db, workspace.id);

    const first = await request(app).post("/api/dashboard/claim").send({ token });
    expect(first.status).toBe(200);
    expect(first.headers["set-cookie"]).toBeDefined();

    const second = await request(app).post("/api/dashboard/claim").send({ token });
    expect(second.status).toBe(400);
  });

  it("rejects protected routes with no cookie", async () => {
    const app = buildTestApp();
    const res = await request(app).get("/api/dashboard/me");
    expect(res.status).toBe(401);
  });

  it("GET /me returns workspace info for the session", async () => {
    const app = buildTestApp();
    const workspace = await seedWorkspace("T2");
    const cookie = await claimSessionCookie(app, workspace.id);

    const res = await request(app).get("/api/dashboard/me").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.slackTeamId).toBe("T2");
    expect(res.body.revoked).toBe(false);
  });

  it("GET/PATCH /namespaces supports rename and archive, scoped to the session's workspace", async () => {
    const app = buildTestApp();
    const workspace = await seedWorkspace("T3");
    const [namespace] = await db
      .insert(namespaces)
      .values({ workspaceId: workspace.id, channelId: "C1", threadTs: "1.1" })
      .returning();
    const cookie = await claimSessionCookie(app, workspace.id);

    const list = await request(app).get("/api/dashboard/namespaces").set("Cookie", cookie);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].label).toBeNull();

    const renamed = await request(app)
      .patch(`/api/dashboard/namespaces/${namespace.id}`)
      .set("Cookie", cookie)
      .send({ label: "Launch planning" });
    expect(renamed.status).toBe(200);
    expect(renamed.body.label).toBe("Launch planning");

    const archived = await request(app)
      .patch(`/api/dashboard/namespaces/${namespace.id}`)
      .set("Cookie", cookie)
      .send({ status: "archived" });
    expect(archived.body.status).toBe("archived");

    const cleared = await request(app)
      .patch(`/api/dashboard/namespaces/${namespace.id}`)
      .set("Cookie", cookie)
      .send({ label: "" });
    expect(cleared.body.label).toBeNull();
  });

  it("a workspace's session cannot read or mutate another workspace's namespace", async () => {
    const app = buildTestApp();
    const workspaceA = await seedWorkspace("T4A");
    const workspaceB = await seedWorkspace("T4B");
    const [namespaceB] = await db
      .insert(namespaces)
      .values({ workspaceId: workspaceB.id, channelId: "C1", threadTs: "1.1" })
      .returning();
    const cookieA = await claimSessionCookie(app, workspaceA.id);

    const list = await request(app).get("/api/dashboard/namespaces").set("Cookie", cookieA);
    expect(list.body).toHaveLength(0);

    const patch = await request(app)
      .patch(`/api/dashboard/namespaces/${namespaceB.id}`)
      .set("Cookie", cookieA)
      .send({ label: "should not work" });
    expect(patch.status).toBe(404);

    const [stillUnlabeled] = await db.select().from(namespaces).where(eq(namespaces.id, namespaceB.id));
    expect(stillUnlabeled.label).toBeNull();
  });

  it("PATCH /namespaces/:id with a non-UUID id returns 404 instead of a DB error", async () => {
    const app = buildTestApp();
    const workspace = await seedWorkspace("T4C");
    const cookie = await claimSessionCookie(app, workspace.id);

    const patch = await request(app)
      .patch("/api/dashboard/namespaces/not-a-uuid")
      .set("Cookie", cookie)
      .send({ label: "should not work" });
    expect(patch.status).toBe(404);
    expect(patch.body.error).toBe("namespace_not_found");
  });

  it("GET /users lists only users with an active key, and revoke-key is idempotent", async () => {
    const app = buildTestApp();
    const workspace = await seedWorkspace("T5");
    const [userWithKey] = await db
      .insert(users)
      .values({ workspaceId: workspace.id, slackUserId: "U1", delegateKeyHash: hashDelegateKey("rk_test") })
      .returning();
    await db.insert(users).values({ workspaceId: workspace.id, slackUserId: "U2", delegateKeyHash: null });
    const cookie = await claimSessionCookie(app, workspace.id);

    const list = await request(app).get("/api/dashboard/users").set("Cookie", cookie);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].slackUserId).toBe("U1");
    expect(list.body[0].displayName).toBeNull();
    expect(list.body[0].avatarUrl).toBeNull();

    const revoke = await request(app).post(`/api/dashboard/users/${userWithKey.id}/revoke-key`).set("Cookie", cookie);
    expect(revoke.status).toBe(200);
    expect(revoke.body.revoked).toBe(true);

    const revokeAgain = await request(app).post(`/api/dashboard/users/${userWithKey.id}/revoke-key`).set("Cookie", cookie);
    expect(revokeAgain.status).toBe(200);
    expect(revokeAgain.body.revoked).toBe(false);

    const afterList = await request(app).get("/api/dashboard/users").set("Cookie", cookie);
    expect(afterList.body).toHaveLength(0);
  });

  it("a workspace's session cannot read or revoke another workspace's user key", async () => {
    const app = buildTestApp();
    const workspaceA = await seedWorkspace("T5A");
    const workspaceB = await seedWorkspace("T5B");
    const [userB] = await db
      .insert(users)
      .values({ workspaceId: workspaceB.id, slackUserId: "U1", delegateKeyHash: hashDelegateKey("rk_other") })
      .returning();
    const cookieA = await claimSessionCookie(app, workspaceA.id);

    const list = await request(app).get("/api/dashboard/users").set("Cookie", cookieA);
    expect(list.body).toHaveLength(0);

    const revoke = await request(app).post(`/api/dashboard/users/${userB.id}/revoke-key`).set("Cookie", cookieA);
    expect(revoke.status).toBe(200);
    expect(revoke.body.revoked).toBe(false);

    const [stillHasKey] = await db.select().from(users).where(eq(users.id, userB.id));
    expect(stillHasKey.delegateKeyHash).not.toBeNull();
  });

  it("POST /users/:id/revoke-key with a non-UUID id is a no-op instead of a DB error", async () => {
    const app = buildTestApp();
    const workspace = await seedWorkspace("T5C");
    const cookie = await claimSessionCookie(app, workspace.id);

    const revoke = await request(app).post("/api/dashboard/users/not-a-uuid/revoke-key").set("Cookie", cookie);
    expect(revoke.status).toBe(200);
    expect(revoke.body).toEqual({ ok: true, revoked: false });
  });

  it("GET /namespaces/:id/messages returns the captured thread in order, with attached files", async () => {
    const app = buildTestApp();
    const workspace = await seedWorkspace("T7");
    const [namespace] = await db
      .insert(namespaces)
      .values({ workspaceId: workspace.id, channelId: "C1", threadTs: "1.1" })
      .returning();
    const [firstMessage] = await db
      .insert(messages)
      .values({ namespaceId: namespace.id, slackUserId: "U1", text: "first", slackTs: "1700000000.000100" })
      .returning();
    await db
      .insert(messages)
      .values({ namespaceId: namespace.id, slackUserId: "U2", text: "second", slackTs: "1700000001.000200" });
    await db.insert(files).values({
      messageId: firstMessage.id,
      originalName: "diagram.png",
      mimeType: "image/png",
      status: "stored",
    });
    const cookie = await claimSessionCookie(app, workspace.id);

    const res = await request(app).get(`/api/dashboard/namespaces/${namespace.id}/messages`).set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.messages).toHaveLength(2);
    expect(res.body.messages[0].text).toBe("first");
    expect(res.body.messages[0].displayName).toBeNull();
    expect(res.body.messages[0].avatarUrl).toBeNull();
    expect(res.body.messages[0].files).toHaveLength(1);
    expect(res.body.messages[0].files[0].originalName).toBe("diagram.png");
    expect(res.body.messages[1].text).toBe("second");
    expect(res.body.messages[1].files).toHaveLength(0);
    expect(res.body.linearIssues).toEqual([]);
  });

  it("GET /namespaces/:id/messages returns 404 for a namespace owned by another workspace", async () => {
    const app = buildTestApp();
    const workspaceA = await seedWorkspace("T8A");
    const workspaceB = await seedWorkspace("T8B");
    const [namespaceB] = await db
      .insert(namespaces)
      .values({ workspaceId: workspaceB.id, channelId: "C1", threadTs: "1.1" })
      .returning();
    const cookieA = await claimSessionCookie(app, workspaceA.id);

    const res = await request(app).get(`/api/dashboard/namespaces/${namespaceB.id}/messages`).set("Cookie", cookieA);
    expect(res.status).toBe(404);
  });

  it("GET /namespaces includes linked Linear issues, deduped, per namespace", async () => {
    const app = buildTestApp();
    const workspace = await seedWorkspace("T9");
    const [namespace] = await db
      .insert(namespaces)
      .values({ workspaceId: workspace.id, channelId: "C1", threadTs: "1.1" })
      .returning();
    await db.insert(namespaceLinearIssues).values({
      namespaceId: namespace.id,
      workspaceSlug: "mysten-labs",
      issueIdentifier: "WALM-297",
    });
    const cookie = await claimSessionCookie(app, workspace.id);

    const res = await request(app).get("/api/dashboard/namespaces").set("Cookie", cookie);
    expect(res.body[0].linearIssues).toEqual([
      { identifier: "WALM-297", url: "https://linear.app/mysten-labs/issue/WALM-297" },
    ]);
  });

  it("GET /namespaces/:id/messages includes linked Linear issues in the new response shape", async () => {
    const app = buildTestApp();
    const workspace = await seedWorkspace("T10");
    const [namespace] = await db
      .insert(namespaces)
      .values({ workspaceId: workspace.id, channelId: "C1", threadTs: "1.1" })
      .returning();
    await db.insert(namespaceLinearIssues).values({
      namespaceId: namespace.id,
      workspaceSlug: "mysten-labs",
      issueIdentifier: "WALM-42",
    });
    const cookie = await claimSessionCookie(app, workspace.id);

    const res = await request(app).get(`/api/dashboard/namespaces/${namespace.id}/messages`).set("Cookie", cookie);
    expect(res.body.linearIssues).toEqual([
      { identifier: "WALM-42", url: "https://linear.app/mysten-labs/issue/WALM-42" },
    ]);
  });

  it("a workspace's session cannot see another workspace's linked Linear issues via either endpoint", async () => {
    const app = buildTestApp();
    const workspaceA = await seedWorkspace("T11A");
    const workspaceB = await seedWorkspace("T11B");
    const [namespaceB] = await db
      .insert(namespaces)
      .values({ workspaceId: workspaceB.id, channelId: "C1", threadTs: "1.1" })
      .returning();
    await db.insert(namespaceLinearIssues).values({
      namespaceId: namespaceB.id,
      workspaceSlug: "mysten-labs",
      issueIdentifier: "WALM-99",
    });
    const cookieA = await claimSessionCookie(app, workspaceA.id);

    const list = await request(app).get("/api/dashboard/namespaces").set("Cookie", cookieA);
    expect(list.body).toHaveLength(0);

    const messagesRes = await request(app)
      .get(`/api/dashboard/namespaces/${namespaceB.id}/messages`)
      .set("Cookie", cookieA);
    expect(messagesRes.status).toBe(404);
  });

  it("a workspace's session never sees a cached name/avatar seeded against another workspace's identical Slack user id", async () => {
    const app = buildTestApp();
    const workspaceA = await seedWorkspace("T12A");
    const workspaceB = await seedWorkspace("T12B");
    const [namespaceA] = await db
      .insert(namespaces)
      .values({ workspaceId: workspaceA.id, channelId: "C1", threadTs: "1.1" })
      .returning();
    await db.insert(messages).values({ namespaceId: namespaceA.id, slackUserId: "U1", text: "hi", slackTs: "1.1" });
    await db.insert(slackUserProfiles).values({
      workspaceId: workspaceB.id,
      slackUserId: "U1",
      displayName: "Bob From Workspace B",
      avatarUrl: "https://example.com/bob.png",
      resolvedAt: new Date(),
    });
    const cookieA = await claimSessionCookie(app, workspaceA.id);

    const res = await request(app).get(`/api/dashboard/namespaces/${namespaceA.id}/messages`).set("Cookie", cookieA);
    expect(res.body.messages[0].displayName).toBeNull();
  });

  it("POST /logout clears the cookie", async () => {
    const app = buildTestApp();
    const workspace = await seedWorkspace("T6");
    const cookie = await claimSessionCookie(app, workspace.id);

    const res = await request(app).post("/api/dashboard/logout").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.headers["set-cookie"][0]).toMatch(/recall_dashboard_session=;/);
  });
});
