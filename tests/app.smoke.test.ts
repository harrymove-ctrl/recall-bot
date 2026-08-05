import { describe, it, expect } from "vitest";
import request from "supertest";
import { buildApp } from "../src/server.js";

describe("buildApp", () => {
  it("responds to GET /healthz with 200 and ok:true", async () => {
    const app = buildApp();
    const res = await request(app).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});
