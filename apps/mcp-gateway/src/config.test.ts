import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const BASE_ENV = {
  PUBLIC_BASE_URL: "https://dev-mcp.example.com/",
  MCP_PATH: "/mcp"
};

describe("loadConfig", () => {
  it("defaults to development mode with no derived OAuth issuer", () => {
    const config = loadConfig({ ...BASE_ENV });
    expect(config.AUTH_MODE).toBe("development");
    expect(config.oauthIssuer).toBeUndefined();
    expect(config.oauthAudience).toBeUndefined();
  });

  it("derives issuer and audience from PUBLIC_BASE_URL in first-party mode", () => {
    const config = loadConfig({ ...BASE_ENV, AUTH_MODE: "first-party", OAUTH_OPERATOR_PASSWORD_HASH: "scrypt:N=16384,r=8,p=1:a:b" });
    expect(config.oauthIssuer).toBe("https://dev-mcp.example.com");
    expect(config.oauthAudience).toBe("https://dev-mcp.example.com/mcp");
  });

  it("keeps the configured issuer/audience in external oauth mode", () => {
    const config = loadConfig({
      ...BASE_ENV,
      AUTH_MODE: "oauth",
      OAUTH_ISSUER: "https://issuer.example.com",
      OAUTH_AUDIENCE: "https://audience.example.com",
      OAUTH_JWKS_URI: "https://issuer.example.com/jwks.json"
    });
    expect(config.oauthIssuer).toBe("https://issuer.example.com");
    expect(config.oauthAudience).toBe("https://audience.example.com");
  });

  it("rejects production startup in development mode", () => {
    expect(() => loadConfig({ ...BASE_ENV, NODE_ENV: "production", AUTH_MODE: "development" })).toThrow(/Production/);
  });

  it("allows production startup in first-party mode with a password hash", () => {
    expect(() => loadConfig({
      ...BASE_ENV, NODE_ENV: "production", AUTH_MODE: "first-party", OAUTH_OPERATOR_PASSWORD_HASH: "scrypt:N=16384,r=8,p=1:a:b"
    })).not.toThrow();
  });

  it("rejects oauth mode missing required variables", () => {
    expect(() => loadConfig({ ...BASE_ENV, AUTH_MODE: "oauth" })).toThrow(/OAUTH_ISSUER/);
  });

  it("rejects first-party mode without a password hash", () => {
    expect(() => loadConfig({ ...BASE_ENV, AUTH_MODE: "first-party" })).toThrow(/OAUTH_OPERATOR_PASSWORD_HASH/);
  });

  it("keeps arbitrary host commands and agent execution independently disabled by default", () => {
    const config = loadConfig({ ...BASE_ENV });
    expect(config.HOST_EXECUTION).toBe("disabled");
    expect(config.AGENT_EXECUTION).toBe("disabled");
  });

  it("allows agent execution without enabling arbitrary host commands", () => {
    const config = loadConfig({ ...BASE_ENV, AGENT_EXECUTION: "enabled", HOST_EXECUTION: "disabled" });
    expect(config.AGENT_EXECUTION).toBe("enabled");
    expect(config.HOST_EXECUTION).toBe("disabled");
  });

  it("accepts a local-files profile with a fixed SSH handoff target", () => {
    const config = loadConfig({
      ...BASE_ENV,
      GATEWAY_NAME: "mac-project-files",
      GATEWAY_PROFILE: "local-files",
      HANDOFF_OUTBOX_DIR: "/tmp/outbox",
      HANDOFF_SSH_TARGET: "gptsync@167.233.75.192",
      HANDOFF_SSH_KEY_PATH: "/tmp/handoff-key",
      HANDOFF_SSH_KNOWN_HOSTS_PATH: "/tmp/known-hosts"
    });
    expect(config.GATEWAY_NAME).toBe("mac-project-files");
    expect(config.GATEWAY_PROFILE).toBe("local-files");
    expect(config.HANDOFF_SSH_TARGET).toBe("gptsync@167.233.75.192");
  });
});
