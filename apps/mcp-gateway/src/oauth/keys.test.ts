import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadOrCreateSigningKey } from "./keys.js";

describe("loadOrCreateSigningKey", () => {
  it("creates a 0600 key file on first boot", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gptdev-oauth-key-"));
    const path = join(dir, "signing-key.pem");
    await loadOrCreateSigningKey(path);
    const info = await stat(path);
    expect(info.mode & 0o777).toBe(0o600);
  });

  it("produces a stable kid across reloads of the same key", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gptdev-oauth-key-"));
    const path = join(dir, "signing-key.pem");
    const first = await loadOrCreateSigningKey(path);
    const second = await loadOrCreateSigningKey(path);
    expect(second.kid).toBe(first.kid);
  });

  it("never exposes the private 'd' component in the public JWK", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gptdev-oauth-key-"));
    const path = join(dir, "signing-key.pem");
    const key = await loadOrCreateSigningKey(path);
    expect(key.publicJwk).not.toHaveProperty("d");
    expect(key.publicJwk.kty).toBe("EC");
    expect(key.publicJwk.crv).toBe("P-256");
  });
});
