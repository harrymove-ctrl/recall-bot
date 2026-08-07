import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { db } from "../../src/db/client.js";
import { createSlackReceiver, createSlackApp } from "../../src/slack/receiver.js";

describe("createSlackReceiver", () => {
  it("redirects GET /slack/install to Slack's authorize URL", async () => {
    const app = express();
    const receiver = createSlackReceiver({
      db,
      app,
      signingSecret: "test-signing-secret",
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
      stateSecret: "test-state-secret-test-state-secret",
      publicBaseUrl: "https://example.test",
    });
    createSlackApp(receiver);

    const res = await request(app).get("/slack/install");
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("https://slack.com/oauth/v2/authorize");
    expect(res.headers.location).toContain("client_id=test-client-id");
  });

  it("accepts a publicBaseUrl param and still builds without throwing", async () => {
    const app = express();
    expect(() =>
      createSlackReceiver({
        db,
        app,
        signingSecret: "test-signing-secret",
        clientId: "test-client-id",
        clientSecret: "test-client-secret",
        stateSecret: "test-state-secret-test-state-secret",
        publicBaseUrl: "https://example.test",
      }),
    ).not.toThrow();
  });

  it("redirects OAuth failures to the landing page with install_error=1", async () => {
    const app = express();
    const receiver = createSlackReceiver({
      db,
      app,
      signingSecret: "test-signing-secret",
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
      stateSecret: "test-state-secret-test-state-secret",
      publicBaseUrl: "https://example.test",
    });
    createSlackApp(receiver);

    const res = await request(app).get("/slack/oauth_redirect");
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);
    expect(res.headers.location).toBe("/?install_error=1");
  });
});
