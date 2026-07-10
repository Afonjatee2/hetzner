import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { isValidCodeChallenge, randomToken, sha256Hex, verifyCodeVerifier } from "./pkce.js";

function challengeFor(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

describe("pkce", () => {
  it("validates S256 challenges only", () => {
    const verifier = randomToken();
    expect(isValidCodeChallenge(challengeFor(verifier), "S256")).toBe(true);
    expect(isValidCodeChallenge(challengeFor(verifier), "plain")).toBe(false);
    expect(isValidCodeChallenge(challengeFor(verifier), undefined)).toBe(false);
    expect(isValidCodeChallenge(undefined, "S256")).toBe(false);
    expect(isValidCodeChallenge("too-short", "S256")).toBe(false);
  });

  it("verifies a matching verifier", () => {
    const verifier = randomToken();
    const challenge = challengeFor(verifier);
    expect(verifyCodeVerifier(verifier, challenge)).toBe(true);
  });

  it("rejects a mismatched verifier", () => {
    const verifier = randomToken();
    const challenge = challengeFor(verifier);
    expect(verifyCodeVerifier(randomToken(), challenge)).toBe(false);
  });

  it("rejects invalid verifier shapes", () => {
    expect(verifyCodeVerifier("short", challengeFor("short"))).toBe(false);
  });

  it("produces deterministic hashes and unique tokens", () => {
    expect(sha256Hex("abc")).toBe(sha256Hex("abc"));
    expect(randomToken()).not.toBe(randomToken());
  });
});
