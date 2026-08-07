import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { createUserSessionCookie, verifyUserSessionCookie } from "../../src/dashboard/userSession.js";

const SECRET = "test-secret-at-least-this-long";

describe("createUserSessionCookie / verifyUserSessionCookie", () => {
  it("round-trips a valid cookie", () => {
    const cookie = createUserSessionCookie("ws-123", "U100", SECRET);
    const result = verifyUserSessionCookie(cookie, SECRET);
    expect(result).toEqual({ workspaceId: "ws-123", slackUserId: "U100" });
  });

  it("rejects a cookie signed with a different secret", () => {
    const cookie = createUserSessionCookie("ws-123", "U100", SECRET);
    expect(verifyUserSessionCookie(cookie, "wrong-secret-also-long-enough")).toBeNull();
  });

  it("rejects a tampered payload", () => {
    const cookie = createUserSessionCookie("ws-123", "U100", SECRET);
    const [payload, sig] = cookie.split(".");
    const tamperedPayload = Buffer.from(
      JSON.stringify({ workspaceId: "ws-999", slackUserId: "U100", exp: Date.now() + 100000 }),
      "utf8",
    ).toString("base64url");
    expect(verifyUserSessionCookie(`${tamperedPayload}.${sig}`, SECRET)).toBeNull();
    expect(payload).toBeDefined();
  });

  it("rejects an expired cookie", () => {
    const cookie = createUserSessionCookie("ws-123", "U100", SECRET, -1000);
    expect(verifyUserSessionCookie(cookie, SECRET)).toBeNull();
  });

  it("rejects malformed input without throwing", () => {
    expect(verifyUserSessionCookie(undefined, SECRET)).toBeNull();
    expect(verifyUserSessionCookie("", SECRET)).toBeNull();
    expect(verifyUserSessionCookie("not-a-valid-cookie-at-all", SECRET)).toBeNull();
    expect(verifyUserSessionCookie("a.b", SECRET)).toBeNull();
    expect(() => verifyUserSessionCookie("short.sig", SECRET)).not.toThrow();
  });

  it("rejects a payload missing slackUserId (e.g. an admin-shaped payload)", () => {
    const payload = { workspaceId: "ws-123", exp: Date.now() + 100000 };
    const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    // Hand-construct using the same signing approach (HMAC-SHA256 over the payload) as the module under test.
    const sig = createHmac("sha256", SECRET).update(payloadB64).digest("base64url");
    expect(verifyUserSessionCookie(`${payloadB64}.${sig}`, SECRET)).toBeNull();
  });
});
