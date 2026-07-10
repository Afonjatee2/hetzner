import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const N = 16384;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, KEY_LENGTH, { N, r: R, p: P }).toString("hex");
  return `scrypt:N=${N},r=${R},p=${P}:${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  try {
    const [scheme, params, salt, hash] = stored.split(":");
    if (scheme !== "scrypt" || !params || !salt || !hash) return false;
    const match = /^N=(\d+),r=(\d+),p=(\d+)$/.exec(params);
    if (!match?.[1] || !match[2] || !match[3]) return false;
    const n = Number(match[1]);
    const r = Number(match[2]);
    const p = Number(match[3]);
    const expected = Buffer.from(hash, "hex");
    if (expected.length === 0) return false;
    const derived = scryptSync(password, salt, expected.length, { N: n, r, p });
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}
