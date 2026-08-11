import { describe, it, expect, afterEach, vi } from "vitest";
import request from "supertest";
import { db } from "../src/db/client.js";
import { buildApp } from "../src/server.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("buildApp (wired)", () => {
  it("still serves /healthz", async () => {
    const app = buildApp(db);
    const res = await request(app).get("/healthz");
    expect(res.status).toBe(200);
  });

  it("exposes /mcp and rejects unauthenticated calls", async () => {
    const app = buildApp(db);
    const res = await request(app).post("/mcp").send({});
    expect(res.status).toBe(401);
  });

  it("exposes /slack/install", async () => {
    const app = buildApp(db);
    const res = await request(app).get("/slack/install");
    expect(res.status).toBe(302);
  });

  // Without these the S3 client happily builds with empty credentials and every upload is lost
  // at capture time; boot is the only place a misconfigured deploy can still be caught cheaply.
  it.each(["BUCKET", "ACCESS_KEY_ID", "SECRET_ACCESS_KEY", "ENDPOINT"])(
    "refuses to boot when %s is not configured",
    (name) => {
      vi.stubEnv(name, "");
      expect(() => buildApp(db)).toThrow(`Missing required environment variable: ${name}`);
    },
  );

  it.each(["SLACK_SIGNING_SECRET", "SLACK_CLIENT_ID", "SLACK_CLIENT_SECRET", "SLACK_STATE_SECRET"])(
    "refuses to boot when %s is not configured",
    (name) => {
      vi.stubEnv(name, "");
      expect(() => buildApp(db)).toThrow(`Missing required environment variable: ${name}`);
    },
  );

  it("serves the dashboard static bundle and claim page", async () => {
    const app = buildApp(db);
    const indexRes = await request(app).get("/dashboard");
    expect(indexRes.status).toBe(200);
    expect(indexRes.text).toContain("bundle.js");

    // The script tag must resolve correctly when the page is served from the exact "/dashboard"
    // path (no trailing slash) — a relative "./bundle.js" would resolve to "/bundle.js", which
    // nothing serves. Extract the actual src and confirm that exact URL is fetchable.
    const scriptSrcMatch = indexRes.text.match(/<script src="([^"]+)"/);
    expect(scriptSrcMatch).not.toBeNull();
    const scriptSrc = scriptSrcMatch![1];
    expect(scriptSrc).toBe("/dashboard/bundle.js");
    const bundleRes = await request(app).get(scriptSrc);
    expect(bundleRes.status).toBe(200);

    const claimRes = await request(app).get("/dashboard/claim");
    expect(claimRes.status).toBe(200);
    expect(claimRes.text).toContain("bundle.js");
  });

  it("exposes /api/dashboard/me and rejects unauthenticated calls", async () => {
    const app = buildApp(db);
    const res = await request(app).get("/api/dashboard/me");
    expect(res.status).toBe(401);
  });

  it("starts Slack personal sign-in with only user identity scope", async () => {
    const app = buildApp(db);
    const res = await request(app).get("/auth/slack");

    expect(res.status).toBe(302);
    const location = new URL(res.headers.location);
    expect(location.origin).toBe("https://slack.com");
    expect(location.pathname).toBe("/openid/connect/authorize");
    expect(location.searchParams.get("response_type")).toBe("code");
    expect(location.searchParams.get("redirect_uri")).toBe("https://recall-bot.test/auth/slack/callback");
    expect(location.searchParams.get("scope")).toBe("openid profile");
    expect(location.searchParams.has("user_scope")).toBe(false);
    expect(location.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it("rejects Slack personal sign-in callbacks with an invalid state", async () => {
    const app = buildApp(db);
    const res = await request(app).get("/auth/slack/callback?code=test-code&state=invalid");

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/dashboard?slack_auth_error=invalid_state");
  });

  it("routes Slack personal sign-in callback errors back to the dashboard sign-in page", async () => {
    const app = buildApp(db);
    const start = await request(app).get("/auth/slack");
    const state = new URL(start.headers.location).searchParams.get("state");

    const res = await request(app).get(`/auth/slack/callback?state=${encodeURIComponent(state ?? "")}`);

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/dashboard?slack_auth_error=no_code");
  });

  it("refuses to boot when USER_SESSION_SECRET is not configured", () => {
    vi.stubEnv("USER_SESSION_SECRET", "");
    expect(() => buildApp(db)).toThrow("Missing required environment variable: USER_SESSION_SECRET");
  });

  it("refuses to boot when USER_SESSION_SECRET equals DASHBOARD_SESSION_SECRET", () => {
    vi.stubEnv("USER_SESSION_SECRET", process.env.DASHBOARD_SESSION_SECRET ?? "");
    expect(() => buildApp(db)).toThrow(/USER_SESSION_SECRET must not equal DASHBOARD_SESSION_SECRET/);
  });

  it("serves the personal-view SPA shell routes", async () => {
    const app = buildApp(db);
    for (const path of ["/dashboard/me", "/dashboard/me/claim", "/dashboard/me/namespaces/00000000-0000-0000-0000-000000000000"]) {
      const res = await request(app).get(path);
      expect(res.status).toBe(200);
      expect(res.text).toContain("bundle.js");
    }
  });

  it("serves the dashboard shell with a 404 status for unknown dashboard routes", async () => {
    const app = buildApp(db);
    const res = await request(app).get("/dashboard/this-page-does-not-exist");

    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.text).toContain('<div id="root"></div>');
  });

  it("serves the dashboard 404 shell for unknown browser page routes", async () => {
    const app = buildApp(db);
    const res = await request(app).get("/1123");

    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.text).toContain('<div id="root"></div>');
    expect(res.text).not.toContain("Cannot GET /1123");
  });

  it("does not serve the dashboard shell for unknown API routes", async () => {
    const app = buildApp(db);
    const res = await request(app).get("/api/does-not-exist");

    expect(res.status).toBe(404);
    expect(res.text).not.toContain('<div id="root"></div>');
  });

  it("exposes /api/me/me and rejects unauthenticated calls", async () => {
    const app = buildApp(db);
    const res = await request(app).get("/api/me/me");
    expect(res.status).toBe(401);
  });
});
