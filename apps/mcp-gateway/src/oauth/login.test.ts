import { createHmac, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createCsrfToken, LoginRateLimiter, renderLoginPage, verifyCsrfToken } from "./login.js";

describe("csrf tokens", () => {
  it("verifies a freshly created token", () => {
    const secret = randomBytes(32);
    const token = createCsrfToken(secret);
    expect(verifyCsrfToken(secret, token)).toBe(true);
  });

  it("rejects a tampered token", () => {
    const secret = randomBytes(32);
    const token = createCsrfToken(secret);
    const [issuedAt] = token.split(".");
    expect(verifyCsrfToken(secret, `${issuedAt}.deadbeef`)).toBe(false);
  });

  it("rejects an expired token", () => {
    const secret = randomBytes(32);
    const staleIssuedAt = (Date.now() - 20 * 60 * 1000).toString(36);
    const mac = createHmac("sha256", secret).update(staleIssuedAt).digest("hex");
    const staleToken = `${staleIssuedAt}.${mac}`;
    expect(verifyCsrfToken(secret, staleToken, 10 * 60 * 1000)).toBe(false);
  });

  it("rejects missing or malformed tokens", () => {
    const secret = randomBytes(32);
    expect(verifyCsrfToken(secret, undefined)).toBe(false);
    expect(verifyCsrfToken(secret, "no-dot-here")).toBe(false);
    expect(verifyCsrfToken(secret, "")).toBe(false);
  });
});

describe("LoginRateLimiter", () => {
  it("allows five failures per IP then blocks the sixth", () => {
    const limiter = new LoginRateLimiter(15 * 60 * 1000, 5, 20);
    for (let i = 0; i < 5; i += 1) {
      expect(limiter.isBlocked("1.2.3.4")).toBe(false);
      limiter.recordFailure("1.2.3.4");
    }
    expect(limiter.isBlocked("1.2.3.4")).toBe(true);
  });

  it("only counts failed attempts - repeated read-only checks never consume the budget", () => {
    const limiter = new LoginRateLimiter(15 * 60 * 1000, 3, 20);
    for (let i = 0; i < 50; i += 1) {
      expect(limiter.isBlocked("5.5.5.5")).toBe(false);
    }
    limiter.recordFailure("5.5.5.5");
    limiter.recordFailure("5.5.5.5");
    expect(limiter.isBlocked("5.5.5.5")).toBe(false);
    limiter.recordFailure("5.5.5.5");
    expect(limiter.isBlocked("5.5.5.5")).toBe(true);
  });

  it("never blocks a fresh IP because of another IP's failures - the global counter is informational only", () => {
    const limiter = new LoginRateLimiter(15 * 60 * 1000, 100, 3);
    limiter.recordFailure("1.1.1.1");
    limiter.recordFailure("2.2.2.2");
    limiter.recordFailure("3.3.3.3");
    expect(limiter.isGlobalSurgeDetected()).toBe(true);
    // The operator's IP has never failed, so it must still be allowed through
    // even though the global surge threshold has been crossed by other IPs.
    expect(limiter.isBlocked("operator-ip")).toBe(false);
  });

  it("a successful login (no recordFailure call) never erodes the operator's own budget", () => {
    const limiter = new LoginRateLimiter(15 * 60 * 1000, 2, 20);
    // Simulate ten successful logins from the same IP: isBlocked is checked,
    // but recordFailure is never called for a correct password.
    for (let i = 0; i < 10; i += 1) {
      expect(limiter.isBlocked("operator-ip")).toBe(false);
    }
  });
});

describe("renderLoginPage", () => {
  it("escapes XSS attempts in the state parameter", () => {
    const html = renderLoginPage(
      {
        clientId: "client-1",
        redirectUri: "https://chatgpt.com/connector_platform_oauth_redirect",
        state: '"><script>alert(1)</script>',
        scope: "workspace.read",
        codeChallenge: "x".repeat(43),
        codeChallengeMethod: "S256",
        responseType: "code"
      },
      "token"
    );
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
