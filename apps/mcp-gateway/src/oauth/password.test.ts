import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./password.js";

describe("password", () => {
  it("hashes with the documented scrypt format", () => {
    const hash = hashPassword("correct horse battery staple");
    expect(hash).toMatch(/^scrypt:N=16384,r=8,p=1:[0-9a-f]+:[0-9a-f]+$/);
  });

  it("verifies a correct password and rejects an incorrect one", () => {
    const hash = hashPassword("s3cret-password");
    expect(verifyPassword("s3cret-password", hash)).toBe(true);
    expect(verifyPassword("wrong-password", hash)).toBe(false);
  });

  it("returns false for malformed stored hashes instead of throwing", () => {
    expect(verifyPassword("anything", "not-a-valid-hash")).toBe(false);
    expect(verifyPassword("anything", "scrypt:N=16384,r=8,p=1:onlysalt")).toBe(false);
    expect(verifyPassword("anything", "")).toBe(false);
    expect(verifyPassword("anything", "bcrypt:x:y:z")).toBe(false);
  });
});
