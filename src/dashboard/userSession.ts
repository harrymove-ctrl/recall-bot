import { createHmac, timingSafeEqual } from "node:crypto";

const ALGO = "sha256";
const DEFAULT_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 7; // 7 days — matches the admin session's default

function sign(payloadB64Url: string, secret: string): string {
  return createHmac(ALGO, secret).update(payloadB64Url).digest("base64url");
}

export interface UserSession {
  workspaceId: string;
  slackUserId: string;
}

export function createUserSessionCookie(
  workspaceId: string,
  slackUserId: string,
  secret: string,
  maxAgeMs = DEFAULT_MAX_AGE_MS,
): string {
  const payload = { workspaceId, slackUserId, exp: Date.now() + maxAgeMs };
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = sign(payloadB64, secret);
  return `${payloadB64}.${sig}`;
}

export function verifyUserSessionCookie(cookieValue: string | undefined, secret: string): UserSession | null {
  if (!cookieValue) return null;

  const dot = cookieValue.lastIndexOf(".");
  if (dot === -1) return null;

  const payloadB64 = cookieValue.slice(0, dot);
  const sig = cookieValue.slice(dot + 1);

  let sigBuf: Buffer;
  let expectedBuf: Buffer;
  try {
    sigBuf = Buffer.from(sig, "base64url");
    expectedBuf = Buffer.from(sign(payloadB64, secret), "base64url");
  } catch {
    return null;
  }

  // timingSafeEqual THROWS on length mismatch, it does not return false —
  // must guard the length ourselves or a malformed cookie crashes the request.
  // (Same guard as src/dashboard/session.ts, copied deliberately — these two verifiers stay
  // fully independent modules, see docs/superpowers/specs/2026-08-07-personal-view-design.md.)
  if (sigBuf.length !== expectedBuf.length) return null;
  if (!timingSafeEqual(sigBuf, expectedBuf)) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  if (typeof payload !== "object" || payload === null) return null;
  const { workspaceId, slackUserId, exp } = payload as { workspaceId?: unknown; slackUserId?: unknown; exp?: unknown };
  if (typeof workspaceId !== "string") return null;
  if (typeof slackUserId !== "string") return null;
  if (typeof exp !== "number" || Date.now() > exp) return null;

  return { workspaceId, slackUserId };
}
