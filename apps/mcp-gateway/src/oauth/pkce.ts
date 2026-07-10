import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;
const VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;

export function isValidCodeChallenge(challenge: string | undefined, method: string | undefined): boolean {
  return method === "S256" && typeof challenge === "string" && CHALLENGE_PATTERN.test(challenge);
}

export function verifyCodeVerifier(verifier: string, challenge: string): boolean {
  if (!VERIFIER_PATTERN.test(verifier)) return false;
  const computed = Buffer.from(createHash("sha256").update(verifier).digest("base64url"));
  const expected = Buffer.from(challenge);
  if (computed.length !== expected.length) return false;
  return timingSafeEqual(computed, expected);
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}
