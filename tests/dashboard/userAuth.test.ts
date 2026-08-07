import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { createUserSessionCookie } from "../../src/dashboard/userSession.js";
import { requireUserSession, USER_SESSION_COOKIE_NAME, type UserSessionRequest } from "../../src/dashboard/userAuth.js";

const SECRET = "test-secret-at-least-this-long";

function buildTestApp() {
  const app = express();
  app.get("/protected", requireUserSession(SECRET), (req: UserSessionRequest, res) => {
    res.json({ workspaceId: req.workspaceId, slackUserId: req.slackUserId });
  });
  return app;
}

describe("requireUserSession", () => {
  it("returns 401 when no cookie is present", async () => {
    const res = await request(buildTestApp()).get("/protected");
    expect(res.status).toBe(401);
  });

  it("returns 401 for an invalid cookie", async () => {
    const res = await request(buildTestApp()).get("/protected").set("Cookie", `${USER_SESSION_COOKIE_NAME}=garbage`);
    expect(res.status).toBe(401);
  });

  it("attaches workspaceId and slackUserId and calls next for a valid cookie", async () => {
    const cookie = createUserSessionCookie("ws-abc", "U100", SECRET);
    const res = await request(buildTestApp()).get("/protected").set("Cookie", `${USER_SESSION_COOKIE_NAME}=${cookie}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ workspaceId: "ws-abc", slackUserId: "U100" });
  });
});
