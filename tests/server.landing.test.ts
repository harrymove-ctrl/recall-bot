import { describe, it, expect } from "vitest";
import request from "supertest";
import { db } from "../src/db/client.js";
import { buildApp } from "../src/server.js";

describe("GET / (install landing page)", () => {
  it("serves the landing page with a working Add to Slack link", async () => {
    const app = buildApp(db);
    const res = await request(app).get("/");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.text).toContain('href="/slack/install"');
    expect(res.text).toContain("Add to Slack");
  });

  it("does not shadow /healthz or /slack/install", async () => {
    const app = buildApp(db);
    expect((await request(app).get("/healthz")).status).toBe(200);
    expect((await request(app).get("/slack/install")).status).toBe(302);
  });
});
