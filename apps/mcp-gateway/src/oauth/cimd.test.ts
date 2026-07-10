import { describe, expect, it, vi } from "vitest";
import { pinnedLookup, resolveClientIdMetadataDocument } from "./cimd.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const publicLookup = () => Promise.resolve([{ address: "93.184.216.34", family: 4 }]);

describe("resolveClientIdMetadataDocument", () => {
  it("resolves a valid document over https on the chatgpt.com host", async () => {
    const url = "https://chatgpt.com/oauth/client-metadata.json";
    const doc = { client_id: url, redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"] };
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse(doc)));
    const result = await resolveClientIdMetadataDocument(url, { fetchImpl, lookup: publicLookup });
    expect(result).toEqual(doc);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects http client_id URLs", async () => {
    await expect(resolveClientIdMetadataDocument("http://chatgpt.com/client-http.json", { lookup: publicLookup }))
      .rejects.toThrow(/not allowed/);
  });

  it("rejects any host other than chatgpt.com, without touching DNS or the network", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse({})));
    const lookup = vi.fn(publicLookup);
    await expect(resolveClientIdMetadataDocument("https://evil.example.com/client.json", { fetchImpl, lookup }))
      .rejects.toThrow(/not allowed/);
    await expect(resolveClientIdMetadataDocument("https://chatgpt.com.evil.com/client.json", { fetchImpl, lookup }))
      .rejects.toThrow(/not allowed/);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
  });

  it("rejects an IP-literal client_id (host allowlist requires the literal chatgpt.com hostname)", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse({})));
    await expect(resolveClientIdMetadataDocument("https://127.0.0.1/client-ip.json", { fetchImpl, lookup: publicLookup }))
      .rejects.toThrow(/not allowed/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a chatgpt.com hostname that resolves to a private address", async () => {
    const url = "https://chatgpt.com/client-private-dns.json";
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse({})));
    const lookup = () => Promise.resolve([{ address: "10.0.0.5", family: 4 }]);
    await expect(resolveClientIdMetadataDocument(url, { fetchImpl, lookup })).rejects.toThrow(/private/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects newly-added reserved ranges: CGNAT, multicast and NAT64", async () => {
    const cases: [string, { address: string; family: number }][] = [
      ["https://chatgpt.com/client-cgnat.json", { address: "100.64.0.5", family: 4 }],
      ["https://chatgpt.com/client-multicast.json", { address: "224.0.0.1", family: 4 }],
      ["https://chatgpt.com/client-reserved.json", { address: "240.0.0.1", family: 4 }],
      ["https://chatgpt.com/client-nat64.json", { address: "64:ff9b::1", family: 6 }],
      ["https://chatgpt.com/client-unspecified.json", { address: "0.0.0.0", family: 4 }]
    ];
    for (const [url, address] of cases) {
      const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse({})));
      const lookup = () => Promise.resolve([address]);
      await expect(resolveClientIdMetadataDocument(url, { fetchImpl, lookup })).rejects.toThrow(/private/);
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });

  it("rejects a redirect response", async () => {
    const url = "https://chatgpt.com/client-redirect.json";
    const fetchImpl = vi.fn(() => Promise.resolve(new Response(null, { status: 302, headers: { location: "https://evil.example.com" } })));
    await expect(resolveClientIdMetadataDocument(url, { fetchImpl, lookup: publicLookup })).rejects.toThrow(/redirect/);
  });

  it("rejects a document that exceeds the size cap", async () => {
    const url = "https://chatgpt.com/client-huge.json";
    const fetchImpl = vi.fn(() => Promise.resolve(new Response("x".repeat(70_000), { status: 200 })));
    await expect(resolveClientIdMetadataDocument(url, { fetchImpl, lookup: publicLookup })).rejects.toThrow(/size/);
  });

  it("rejects a document whose client_id does not match the fetched URL", async () => {
    const url = "https://chatgpt.com/client-mismatch.json";
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse({ client_id: "https://chatgpt.com/someone-else.json" })));
    await expect(resolveClientIdMetadataDocument(url, { fetchImpl, lookup: publicLookup })).rejects.toThrow(/client_id/);
  });

  it("caches a resolved document and does not refetch within the TTL", async () => {
    const url = "https://chatgpt.com/client-cached.json";
    const doc = { client_id: url, redirect_uris: [] };
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse(doc)));
    await resolveClientIdMetadataDocument(url, { fetchImpl, lookup: publicLookup });
    await resolveClientIdMetadataDocument(url, { fetchImpl, lookup: publicLookup });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects concurrent fetches beyond the in-flight cap", async () => {
    const fetchImpl = vi.fn((input: string | URL | Request) => {
      const requestedUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return Promise.resolve(jsonResponse({ client_id: requestedUrl }));
    });
    const urls = Array.from({ length: 6 }, (_, index) => `https://chatgpt.com/client-concurrency-${index}.json`);
    // The concurrency gate is checked synchronously before the first await, so
    // firing all six calls in the same tick (no per-call await here) reliably
    // exceeds the cap regardless of how fast the mocked fetch resolves.
    const results = await Promise.allSettled(urls.map((url) => resolveClientIdMetadataDocument(url, { fetchImpl, lookup: publicLookup })));
    expect(results.filter((result) => result.status === "rejected").length).toBeGreaterThanOrEqual(2);
  });
});

describe("pinnedLookup", () => {
  it("refuses to hand back a private address even if it was somehow pinned", () => {
    const callback = vi.fn();
    const lookup = pinnedLookup({ address: "10.1.2.3", family: 4 });
    lookup("chatgpt.com", {}, callback);
    expect(callback).toHaveBeenCalledTimes(1);
    const [error] = callback.mock.calls[0] as [unknown];
    expect(error).toBeInstanceOf(Error);
  });

  it("hands back the pinned public address unchanged", () => {
    const callback = vi.fn();
    const lookup = pinnedLookup({ address: "93.184.216.34", family: 4 });
    lookup("chatgpt.com", {}, callback);
    expect(callback).toHaveBeenCalledWith(null, "93.184.216.34", 4);
  });

  it("returns an array form when options.all is set", () => {
    const callback = vi.fn();
    const lookup = pinnedLookup({ address: "93.184.216.34", family: 4 });
    lookup("chatgpt.com", { all: true }, callback);
    expect(callback).toHaveBeenCalledWith(null, [{ address: "93.184.216.34", family: 4 }]);
  });
});
