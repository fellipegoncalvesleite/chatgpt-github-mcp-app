import { describe, expect, it } from "vitest";
import { gmailConfigured, loadConfig } from "../src/config.js";
import { OAUTH_SCOPES, SingleUserOAuthProvider } from "../src/oauth/provider.js";
import { testConfig } from "./helpers.js";

function baseEnv(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    PUBLIC_BASE_URL: "http://localhost:3000",
    GITHUB_APP_ID: "1",
    GITHUB_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\nx\\n-----END PRIVATE KEY-----",
    GITHUB_ALLOWED_REPOSITORIES: "acme/demo",
    OAUTH_SIGNING_SECRET: "test-signing-secret-which-is-long-enough-for-hmac",
    OAUTH_ADMIN_PASSWORD_HASH: "scrypt:c2FsdA:aGFzaA",
    LOCAL_AGENT_TOKEN: "",
  };
}

describe("Gmail configuration", () => {
  it("keeps Gmail disabled when all Gmail settings are absent", () => {
    const config = loadConfig(baseEnv());
    expect(gmailConfigured(config)).toBe(false);
    expect(config.localAgentMaxScreenshotBytes).toBe(1_500_000);
    expect(config.localAgentScreenshotMaxEdge).toBe(1600);
    expect(OAUTH_SCOPES).toContain("gmail:read");
    expect(OAUTH_SCOPES).toContain("gmail:write");
  });

  it("rejects partial Gmail configuration", () => {
    expect(() => loadConfig({
      ...baseEnv(),
      GMAIL_CLIENT_ID: "client-id",
      GMAIL_CLIENT_SECRET: "client-secret",
    })).toThrow(/Gmail configuration requires/i);
  });

  it("enables Gmail only when all four settings are present", () => {
    const config = loadConfig({
      ...baseEnv(),
      GMAIL_CLIENT_ID: "client-id",
      GMAIL_CLIENT_SECRET: "client-secret",
      GMAIL_REFRESH_TOKEN: "refresh-token",
      GMAIL_ACCOUNT_EMAIL: "owner@example.com",
    });
    expect(gmailConfigured(config)).toBe(true);
    expect(config.gmailAccountEmail).toBe("owner@example.com");
  });

  it("adds Gmail bridge scopes to default authorization only when configured", async () => {
    const withoutGmail = testConfig({ localAgentToken: "" });
    const withGmail = testConfig({
      localAgentToken: "",
      gmailClientId: "client-id",
      gmailClientSecret: "client-secret",
      gmailRefreshToken: "refresh-token",
      gmailAccountEmail: "owner@example.com",
    });

    const withoutProvider = new SingleUserOAuthProvider(withoutGmail);
    const withProvider = new SingleUserOAuthProvider(withGmail);

    const withoutScopes = (withoutProvider as unknown as { validateScopes(scopes?: string[], includeConfigured?: boolean): string[] })
      .validateScopes(undefined, true);
    const withScopes = (withProvider as unknown as { validateScopes(scopes?: string[], includeConfigured?: boolean): string[] })
      .validateScopes(undefined, true);

    expect(withoutScopes).not.toContain("gmail:read");
    expect(withoutScopes).not.toContain("gmail:write");
    expect(withScopes).toContain("gmail:read");
    expect(withScopes).toContain("gmail:write");

    const explicitLegacyRequest = (withProvider as unknown as { validateScopes(scopes?: string[], includeConfigured?: boolean): string[] })
      .validateScopes(["github:read", "github:write"], true);
    expect(explicitLegacyRequest).toContain("gmail:read");
    expect(explicitLegacyRequest).toContain("gmail:write");
  });
});
