import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { calculateJwkThumbprint, exportJWK, exportPKCS8, generateKeyPair, importPKCS8, type CryptoKey, type JWK } from "jose";

export interface SigningKey {
  kid: string;
  privateKey: CryptoKey;
  publicJwk: JWK;
}

export async function loadOrCreateSigningKey(pemPath: string): Promise<SigningKey> {
  const privateKey = existsSync(pemPath) ? await importPKCS8(readFileSync(pemPath, "utf8"), "ES256", { extractable: true }) : await createKeyFile(pemPath);
  const jwk = await exportJWK(privateKey);
  const kid = await calculateJwkThumbprint(jwk);
  const publicJwk: JWK = { ...(jwk.kty ? { kty: jwk.kty } : {}), ...(jwk.crv ? { crv: jwk.crv } : {}), ...(jwk.x ? { x: jwk.x } : {}), ...(jwk.y ? { y: jwk.y } : {}), kid, alg: "ES256", use: "sig" };
  return { kid, privateKey, publicJwk };
}

async function createKeyFile(pemPath: string): Promise<CryptoKey> {
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  const pem = await exportPKCS8(privateKey);
  mkdirSync(dirname(pemPath), { recursive: true, mode: 0o750 });
  writeFileSync(pemPath, pem, { mode: 0o600 });
  chmodSync(pemPath, 0o600);
  return privateKey;
}

export function buildJwks(keys: SigningKey[]): { keys: JWK[] } {
  return { keys: keys.map((key) => key.publicJwk) };
}
