import { lookup as dnsLookup } from "node:dns/promises";
import type { LookupAddress, LookupOptions } from "node:dns";
import type { LookupFunction } from "node:net";
import type { ReadableStreamReadResult } from "node:stream/web";
import { Agent, fetch as undiciFetch } from "undici";
import { isAllowedHost } from "./redirects.js";

export interface CimdDeps {
  fetchImpl?: typeof fetch;
  lookup?: (hostname: string) => Promise<{ address: string; family: number }[]>;
}

interface PinnedAddress {
  address: string;
  family: number;
}

const MAX_BYTES = 64 * 1024;
const TIMEOUT_MS = 5000;
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CONCURRENT_FETCHES = 4;

const cache = new Map<string, { doc: Record<string, unknown>; expiresAt: number }>();
let inFlightFetches = 0;

function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  const a = parts[0];
  const b = parts[1];
  if (a === undefined || b === undefined || parts.length !== 4 || parts.some((part) => Number.isNaN(part))) return true;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  if (a >= 224 && a <= 239) return true; // multicast 224.0.0.0/4
  if (a >= 240) return true; // reserved 240.0.0.0/4, incl. 255.255.255.255
  return false;
}

function isPrivateAddress(address: string, family: number): boolean {
  if (family === 4) return isPrivateIpv4(address);
  const lower = address.toLowerCase();
  if (lower === "::1" || lower === "::") return true;
  if (lower.startsWith("fe80:") || lower.startsWith("fc") || lower.startsWith("fd")) return true;
  if (lower.startsWith("::ffff:")) return isPrivateIpv4(lower.slice(7));
  if (lower.startsWith("64:ff9b::")) return true; // NAT64 64:ff9b::/96
  return false;
}

async function resolvePinnedAddress(hostname: string, deps: CimdDeps): Promise<PinnedAddress> {
  const lookupFn = deps.lookup ?? ((host: string) => dnsLookup(host, { all: true }));
  const records = await lookupFn(hostname);
  if (records.length === 0) throw new Error("CIMD host did not resolve");
  for (const record of records) {
    if (isPrivateAddress(record.address, record.family)) throw new Error("CIMD host resolves to a private address");
  }
  const first = records[0];
  if (!first) throw new Error("CIMD host did not resolve");
  return first;
}

// Pins the socket connection to the address already vetted by resolvePinnedAddress,
// so the address the SSRF guard checks is provably the address the TCP connection
// uses (no second, independent DNS resolution inside the HTTP client that could
// return a different, unvetted address - i.e. no DNS-rebinding TOCTOU). The
// private-address check is repeated here too, defense-in-depth, in case a pinned
// address were ever constructed from an unvetted source.
export function pinnedLookup(pinned: PinnedAddress): LookupFunction {
  return (_hostname: string, options: LookupOptions, callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void): void => {
    if (isPrivateAddress(pinned.address, pinned.family)) {
      callback(new Error("Refusing to connect to a private address") as NodeJS.ErrnoException, "");
      return;
    }
    if (options.all) callback(null, [{ address: pinned.address, family: pinned.family }]);
    else callback(null, pinned.address, pinned.family);
  };
}

async function readBoundedBody(response: Response): Promise<string> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body?.getReader();
  if (reader) {
    for (;;) {
      const result: ReadableStreamReadResult<Uint8Array> = await reader.read();
      if (result.done) break;
      const value: Uint8Array = result.value;
      total += value.byteLength;
      if (total > MAX_BYTES) {
        await reader.cancel();
        throw new Error("CIMD document exceeds size limit");
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

export async function resolveClientIdMetadataDocument(clientIdUrl: string, deps: CimdDeps = {}): Promise<Record<string, unknown>> {
  const cached = cache.get(clientIdUrl);
  if (cached && cached.expiresAt > Date.now()) return cached.doc;

  const url = new URL(clientIdUrl);
  // ChatGPT serves its CIMD document from chatgpt.com; restricting the client_id
  // host to this single, fixed domain removes essentially all SSRF surface up
  // front (no attacker-supplied host is ever dereferenced).
  if (!isAllowedHost(url)) throw new Error("CIMD client_id host is not allowed");

  if (inFlightFetches >= MAX_CONCURRENT_FETCHES) throw new Error("CIMD fetch concurrency limit reached");
  inFlightFetches += 1;
  try {
    const pinned = await resolvePinnedAddress(url.hostname, deps);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let response: Response;
    try {
      if (deps.fetchImpl) {
        response = await deps.fetchImpl(clientIdUrl, { redirect: "manual", signal: controller.signal });
        if (response.status >= 300 && response.status < 400) throw new Error("CIMD document must not redirect");
      } else {
        const agent = new Agent({ connect: { lookup: pinnedLookup(pinned), timeout: TIMEOUT_MS } });
        try {
          response = await undiciFetch(clientIdUrl, { redirect: "error", signal: controller.signal, dispatcher: agent }) as unknown as Response;
        } finally {
          await agent.close();
        }
      }
    } catch (error) {
      if (error instanceof Error && error.message === "CIMD document must not redirect") throw error;
      throw new Error(`CIMD fetch failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) throw new Error(`CIMD fetch failed with status ${response.status}`);

    const text = await readBoundedBody(response);
    const doc = JSON.parse(text) as Record<string, unknown>;
    if (doc.client_id !== clientIdUrl) throw new Error("CIMD document client_id mismatch");

    cache.set(clientIdUrl, { doc, expiresAt: Date.now() + CACHE_TTL_MS });
    return doc;
  } finally {
    inFlightFetches -= 1;
  }
}
