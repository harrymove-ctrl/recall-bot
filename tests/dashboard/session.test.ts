import { describe, it, expect } from "vitest";
import { createSessionCookie, verifySessionCookie, parseCookies } from "../../src/dashboard/session.js";

const SECRET = "test-secret-at-least-this-long";

describe("createSessionCookie / verifySessionCookie", () => {
  it("round-trips a valid cookie", () => {
    const cookie = createSessionCookie("ws-123", SECRET);
    const result = verifySessionCookie(cookie, SECRET);
    expect(result).toEqual({ workspaceId: "ws-123" });
  });

  it("rejects a cookie signed with a different secret", () => {
    const cookie = createSessionCookie("ws-123", SECRET);
    expect(verifySessionCookie(cookie, "wrong-secret-also-long-enough")).toBeNull();
  });

  it("rejects a tampered payload", () => {
    const cookie = createSessionCookie("ws-123", SECRET);
    const [payload, sig] = cookie.split(".");
    const tamperedPayload = Buffer.from(JSON.stringify({ workspaceId: "ws-999", exp: Date.now() + 100000 }), "utf8").toString(
      "base64url",
    );
    expect(verifySessionCookie(`${tamperedPayload}.${sig}`, SECRET)).toBeNull();
    expect(payload).toBeDefined();
  });

  it("rejects an expired cookie", () => {
    const cookie = createSessionCookie("ws-123", SECRET, -1000);
    expect(verifySessionCookie(cookie, SECRET)).toBeNull();
  });

  it("rejects malformed input without throwing", () => {
    expect(verifySessionCookie(undefined, SECRET)).toBeNull();
    expect(verifySessionCookie("", SECRET)).toBeNull();
    expect(verifySessionCookie("not-a-valid-cookie-at-all", SECRET)).toBeNull();
    expect(verifySessionCookie("a.b", SECRET)).toBeNull();
    expect(() => verifySessionCookie("short.sig", SECRET)).not.toThrow();
  });
});

describe("parseCookies", () => {
  it("parses a standard Cookie header", () => {
    expect(parseCookies("a=1; b=2; c=hello%20world")).toEqual({ a: "1", b: "2", c: "hello world" });
  });

  it("returns an empty object for undefined or empty header", () => {
    expect(parseCookies(undefined)).toEqual({});
    expect(parseCookies("")).toEqual({});
  });
});
