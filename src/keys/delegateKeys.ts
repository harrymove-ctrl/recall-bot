// src/keys/delegateKeys.ts
import { randomBytes, createHash } from "node:crypto";

const KEY_PREFIX = "rk_";
const KEY_BYTES = 24; // -> 48 hex characters

export function generateDelegateKey(): { plaintext: string; hash: string } {
  const plaintext = `${KEY_PREFIX}${randomBytes(KEY_BYTES).toString("hex")}`;
  return { plaintext, hash: hashDelegateKey(plaintext) };
}

export function hashDelegateKey(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}
