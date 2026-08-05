// tests/keys/delegateKeys.test.ts
import { describe, it, expect } from "vitest";
import { generateDelegateKey, hashDelegateKey } from "../../src/keys/delegateKeys.js";

describe("delegateKeys", () => {
  it("generates a key prefixed with rk_ and a matching hash", () => {
    const { plaintext, hash } = generateDelegateKey();
    expect(plaintext).toMatch(/^rk_[a-f0-9]{48}$/);
    expect(hash).toBe(hashDelegateKey(plaintext));
  });

  it("produces different plaintext keys on each call", () => {
    const a = generateDelegateKey();
    const b = generateDelegateKey();
    expect(a.plaintext).not.toBe(b.plaintext);
    expect(a.hash).not.toBe(b.hash);
  });

  it("hashes deterministically for the same plaintext", () => {
    const { plaintext } = generateDelegateKey();
    expect(hashDelegateKey(plaintext)).toBe(hashDelegateKey(plaintext));
  });
});
