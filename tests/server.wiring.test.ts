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
});
