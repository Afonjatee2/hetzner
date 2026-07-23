import { describe, expect, it } from "vitest";
import { isAllowedRedirectUri } from "./redirects.js";

const QWEN_CALLBACK = "http://localhost:7777/oauth/callback";

describe("isAllowedRedirectUri", () => {
  it("accepts both ChatGPT redirect paths", () => {
    expect(isAllowedRedirectUri("https://chatgpt.com/connector_platform_oauth_redirect")).toBe(true);
    expect(isAllowedRedirectUri("https://chatgpt.com/connector/oauth/abc123")).toBe(true);
  });

  it("accepts the exact Perplexity OAuth callbacks", () => {
    expect(isAllowedRedirectUri("https://www.perplexity.ai/rest/connections/oauth_callback")).toBe(true);
    expect(isAllowedRedirectUri("https://www.perplexity.com/rest/connections/oauth_callback")).toBe(true);
    expect(isAllowedRedirectUri("https://enterprise.perplexity.ai/rest/connections/oauth_callback")).toBe(true);
    expect(isAllowedRedirectUri("https://enterprise.perplexity.com/rest/connections/oauth_callback")).toBe(true);
    expect(isAllowedRedirectUri("https://n.perplexity.ai/rest/connections/oauth_callback")).toBe(true);
    expect(isAllowedRedirectUri("https://n.perplexity.com/rest/connections/oauth_callback")).toBe(true);
  });

  it("accepts the exact Claude.ai OAuth callbacks", () => {
    expect(isAllowedRedirectUri("https://claude.ai/api/mcp/auth_callback")).toBe(true);
    expect(isAllowedRedirectUri("https://subdomain.claude.ai/api/mcp/auth_callback")).toBe(true);
  });

  it("accepts only the exact Qwen Code loopback callback", () => {
    expect(isAllowedRedirectUri(QWEN_CALLBACK)).toBe(true);
  });

  it("rejects hostile Qwen callback variants", () => {
    const rejected = [
      "http://127.0.0.1:7777/oauth/callback",
      "http://localhost:7778/oauth/callback",
      "http://localhost:7777/oauth/other",
      "https://localhost:7777/oauth/callback",
      "http://sub.localhost:7777/oauth/callback",
      "http://localhost.evil.com:7777/oauth/callback",
      "http://localhost@evil.com:7777/oauth/callback",
      "http://evil.com@localhost:7777/oauth/callback",
      "http://user:pass@localhost:7777/oauth/callback",
      "http://localhost:7777/oauth/callback?code=abc",
      "http://localhost:7777/oauth/callback?",
      "http://localhost:7777/oauth/callback#fragment",
      "http://localhost:7777/oauth/callback#"
    ];
    for (const value of rejected) expect(isAllowedRedirectUri(value), value).toBe(false);
  });

  it("rejects http", () => {
    expect(isAllowedRedirectUri("http://chatgpt.com/connector_platform_oauth_redirect")).toBe(false);
    expect(isAllowedRedirectUri("http://www.perplexity.ai/rest/connections/oauth_callback")).toBe(false);
    expect(isAllowedRedirectUri("http://www.perplexity.com/rest/connections/oauth_callback")).toBe(false);
    expect(isAllowedRedirectUri("http://enterprise.perplexity.ai/rest/connections/oauth_callback")).toBe(false);
    expect(isAllowedRedirectUri("http://enterprise.perplexity.com/rest/connections/oauth_callback")).toBe(false);
    expect(isAllowedRedirectUri("http://n.perplexity.ai/rest/connections/oauth_callback")).toBe(false);
    expect(isAllowedRedirectUri("http://n.perplexity.com/rest/connections/oauth_callback")).toBe(false);
  });

  it("accepts subdomains and alternate Perplexity hosts", () => {
    expect(isAllowedRedirectUri("https://perplexity.ai/rest/connections/oauth_callback")).toBe(true);
    expect(isAllowedRedirectUri("https://perplexity.com/rest/connections/oauth_callback")).toBe(true);
    expect(isAllowedRedirectUri("https://sub.www.perplexity.ai/rest/connections/oauth_callback")).toBe(true);
    expect(isAllowedRedirectUri("https://sub.www.perplexity.com/rest/connections/oauth_callback")).toBe(true);
    expect(isAllowedRedirectUri("https://sub.enterprise.perplexity.ai/rest/connections/oauth_callback")).toBe(true);
    expect(isAllowedRedirectUri("https://sub.enterprise.perplexity.com/rest/connections/oauth_callback")).toBe(true);
    expect(isAllowedRedirectUri("https://sub.n.perplexity.ai/rest/connections/oauth_callback")).toBe(true);
    expect(isAllowedRedirectUri("https://connect.perplexity.ai/rest/connections/oauth_callback")).toBe(true);
  });

  it("rejects subdomains for ChatGPT", () => {
    expect(isAllowedRedirectUri("https://sub.chatgpt.com/connector_platform_oauth_redirect")).toBe(false);
  });

  it("rejects lookalike hosts", () => {
    expect(isAllowedRedirectUri("https://chatgpt.com.evil.com/connector_platform_oauth_redirect")).toBe(false);
    expect(isAllowedRedirectUri("https://www.perplexity.ai.evil.com/rest/connections/oauth_callback")).toBe(false);
    expect(isAllowedRedirectUri("https://www.perplexity.com.evil.com/rest/connections/oauth_callback")).toBe(false);
    expect(isAllowedRedirectUri("https://enterprise.perplexity.ai.evil.com/rest/connections/oauth_callback")).toBe(false);
    expect(isAllowedRedirectUri("https://enterprise.perplexity.com.evil.com/rest/connections/oauth_callback")).toBe(false);
    expect(isAllowedRedirectUri("https://n.perplexity.ai.evil.com/rest/connections/oauth_callback")).toBe(false);
  });

  it("rejects userinfo tricks", () => {
    expect(isAllowedRedirectUri("https://chatgpt.com@evil.com/connector_platform_oauth_redirect")).toBe(false);
    expect(isAllowedRedirectUri("https://user:pass@chatgpt.com/connector_platform_oauth_redirect")).toBe(false);
    expect(isAllowedRedirectUri("https://www.perplexity.ai@evil.com/rest/connections/oauth_callback")).toBe(false);
  });

  it("rejects wrong paths", () => {
    expect(isAllowedRedirectUri("https://chatgpt.com/wrong-path")).toBe(false);
    expect(isAllowedRedirectUri("https://chatgpt.com/connector/oauthx")).toBe(false);
    expect(isAllowedRedirectUri("https://chatgpt.com/connector/oauth/")).toBe(false);
    expect(isAllowedRedirectUri("https://www.perplexity.ai/rest/connections/oauth_callback/extra")).toBe(false);
    expect(isAllowedRedirectUri("https://www.perplexity.ai/oauth_callback")).toBe(false);
  });

  it("rejects non-default ports", () => {
    expect(isAllowedRedirectUri("https://chatgpt.com:8443/connector_platform_oauth_redirect")).toBe(false);
    expect(isAllowedRedirectUri("https://www.perplexity.ai:8443/rest/connections/oauth_callback")).toBe(false);
  });

  it("rejects garbage", () => {
    expect(isAllowedRedirectUri("not a url")).toBe(false);
    expect(isAllowedRedirectUri("")).toBe(false);
  });
});
