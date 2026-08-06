import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { createSessionCookie } from "../../src/dashboard/session.js";
import { requireDashboardSession, DASHBOARD_COOKIE_NAME, type DashboardRequest } from "../../src/dashboard/auth.js";

const SECRET = "test-secret-at-least-this-long";

function buildTestApp() {
  const app = express();
  app.get("/protected", requireDashboardSession(SECRET), (req: DashboardRequest, res) => {
    res.json({ workspaceId: req.workspaceId });
  });
  return app;
}

describe("requireDashboardSession", () => {
  it("returns 401 when no cookie is present", async () => {
    const res = await request(buildTestApp()).get("/protected");
    expect(res.status).toBe(401);
  });

  it("returns 401 for an invalid cookie", async () => {
    const res = await request(buildTestApp()).get("/protected").set("Cookie", `${DASHBOARD_COOKIE_NAME}=garbage`);
    expect(res.status).toBe(401);
  });

  it("attaches workspaceId and calls next for a valid cookie", async () => {
    const cookie = createSessionCookie("ws-abc", SECRET);
    const res = await request(buildTestApp()).get("/protected").set("Cookie", `${DASHBOARD_COOKIE_NAME}=${cookie}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ workspaceId: "ws-abc" });
  });
});
