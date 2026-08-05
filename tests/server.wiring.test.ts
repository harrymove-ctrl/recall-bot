import { describe, it, expect } from "vitest";
import request from "supertest";
import { db } from "../src/db/client.js";
import { buildApp } from "../src/server.js";

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
});
