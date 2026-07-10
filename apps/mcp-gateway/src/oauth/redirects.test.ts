import { describe, expect, it } from "vitest";
import { isAllowedRedirectUri } from "./redirects.js";

describe("isAllowedRedirectUri", () => {
  it("accepts both ChatGPT redirect paths", () => {
    expect(isAllowedRedirectUri("https://chatgpt.com/connector_platform_oauth_redirect")).toBe(true);
    expect(isAllowedRedirectUri("https://chatgpt.com/connector/oauth/abc123")).toBe(true);
  });

  it("rejects http", () => {
    expect(isAllowedRedirectUri("http://chatgpt.com/connector_platform_oauth_redirect")).toBe(false);
  });

  it("rejects subdomains", () => {
    expect(isAllowedRedirectUri("https://sub.chatgpt.com/connector_platform_oauth_redirect")).toBe(false);
  });

  it("rejects lookalike hosts", () => {
    expect(isAllowedRedirectUri("https://chatgpt.com.evil.com/connector_platform_oauth_redirect")).toBe(false);
  });

  it("rejects userinfo tricks", () => {
    expect(isAllowedRedirectUri("https://chatgpt.com@evil.com/connector_platform_oauth_redirect")).toBe(false);
    expect(isAllowedRedirectUri("https://user:pass@chatgpt.com/connector_platform_oauth_redirect")).toBe(false);
  });

  it("rejects wrong paths", () => {
    expect(isAllowedRedirectUri("https://chatgpt.com/wrong-path")).toBe(false);
    expect(isAllowedRedirectUri("https://chatgpt.com/connector/oauthx")).toBe(false);
    expect(isAllowedRedirectUri("https://chatgpt.com/connector/oauth/")).toBe(false);
  });

  it("rejects non-default ports", () => {
    expect(isAllowedRedirectUri("https://chatgpt.com:8443/connector_platform_oauth_redirect")).toBe(false);
  });

  it("rejects garbage", () => {
    expect(isAllowedRedirectUri("not a url")).toBe(false);
    expect(isAllowedRedirectUri("")).toBe(false);
  });
});
