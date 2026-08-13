import { createHmac, timingSafeEqual } from "node:crypto";
const ALGO = "sha256";
const DEFAULT_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 7; // 7 days
function sign(payloadB64Url, secret) {
    return createHmac(ALGO, secret).update(payloadB64Url).digest("base64url");
}
export function createSessionCookie(workspaceId, secret, maxAgeMs = DEFAULT_MAX_AGE_MS) {
    const payload = { workspaceId, exp: Date.now() + maxAgeMs };
    const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const sig = sign(payloadB64, secret);
    return `${payloadB64}.${sig}`;
}
export function verifySessionCookie(cookieValue, secret) {
    if (!cookieValue)
        return null;
    const dot = cookieValue.lastIndexOf(".");
    if (dot === -1)
        return null;
    const payloadB64 = cookieValue.slice(0, dot);
    const sig = cookieValue.slice(dot + 1);
    let sigBuf;
    let expectedBuf;
    try {
        sigBuf = Buffer.from(sig, "base64url");
        expectedBuf = Buffer.from(sign(payloadB64, secret), "base64url");
    }
    catch {
        return null;
    }
    // timingSafeEqual THROWS on length mismatch, it does not return false —
    // must guard the length ourselves or a malformed cookie crashes the request.
    if (sigBuf.length !== expectedBuf.length)
        return null;
    if (!timingSafeEqual(sigBuf, expectedBuf))
        return null;
    let payload;
    try {
        payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
    }
    catch {
        return null;
    }
    if (typeof payload !== "object" || payload === null)
        return null;
    const { workspaceId, exp } = payload;
    if (typeof workspaceId !== "string")
        return null;
    if (typeof exp !== "number" || Date.now() > exp)
        return null;
    return { workspaceId };
}
export function parseCookies(cookieHeader) {
    const out = {};
    if (!cookieHeader)
        return out;
    for (const part of cookieHeader.split(";")) {
        const eq = part.indexOf("=");
        if (eq === -1)
            continue;
        const key = part.slice(0, eq).trim();
        if (!key)
            continue;
        const raw = part.slice(eq + 1).trim();
        try {
            out[key] = decodeURIComponent(raw);
        }
        catch {
            out[key] = raw;
        }
    }
    return out;
}
//# sourceMappingURL=session.js.map