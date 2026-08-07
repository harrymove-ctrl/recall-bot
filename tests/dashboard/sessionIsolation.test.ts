import { describe, it, expect } from "vitest";
import { createSessionCookie, verifySessionCookie } from "../../src/dashboard/session.js";
import { createUserSessionCookie, verifyUserSessionCookie } from "../../src/dashboard/userSession.js";

describe("admin/personal session cross-cookie isolation", () => {
  it("documents the risk class: with a shared secret, a personal-session cookie also verifies as a valid admin session", () => {
    const SHARED = "shared-secret-if-misconfigured-long-enough";
    const userCookie = createUserSessionCookie("ws-1", "U100", SHARED);
    // The extra slackUserId field is silently ignored by verifySessionCookie — it only ever
    // reads workspaceId/exp. This is exactly why USER_SESSION_SECRET must differ in practice
    // (enforced at boot in src/server.ts) — this test exists to prove the risk is real, not
    // hypothetical, and to catch a regression if that boot guard is ever removed.
    expect(verifySessionCookie(userCookie, SHARED)).toEqual({ workspaceId: "ws-1" });
  });

  it("with distinct secrets, a personal-session cookie is never accepted as an admin session", () => {
    const userCookie = createUserSessionCookie("ws-1", "U100", "user-secret-long-enough");
    expect(verifySessionCookie(userCookie, "admin-secret-long-enough")).toBeNull();
  });

  it("an admin-session cookie is never accepted as a personal session (missing slackUserId), regardless of secret", () => {
    const adminCookie = createSessionCookie("ws-1", "shared-or-not-long-enough");
    expect(verifyUserSessionCookie(adminCookie, "shared-or-not-long-enough")).toBeNull();
  });
});
