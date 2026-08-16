import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GMAIL_MODIFY_SCOPE, buildAuthorizationUrl, writeRefreshTokenFile } from "../scripts/gmail-authorize.mjs";

describe("gmail authorization helper", () => {
  it("builds an offline-consent URL for exactly gmail.modify", () => {
    const url = buildAuthorizationUrl({
      clientId: "client-id.apps.googleusercontent.com",
      redirectUri: "http://127.0.0.1:53682/callback",
      state: "state-123",
    });
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe("client-id.apps.googleusercontent.com");
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:53682/callback");
    expect(url.searchParams.get("scope")).toBe(GMAIL_MODIFY_SCOPE);
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("include_granted_scopes")).toBe("true");
    expect(url.searchParams.get("state")).toBe("state-123");
  });

  it("writes only the refresh token env assignment with mode 0600", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gmail-authorize-test-"));
    const path = join(directory, "gmail.env");
    await writeRefreshTokenFile(path, "refresh-secret-token");
    const content = await readFile(path, "utf8");
    const metadata = await stat(path);
    expect(content).toBe("GMAIL_REFRESH_TOKEN=refresh-secret-token\n");
    expect(metadata.mode & 0o777).toBe(0o600);
    expect(content).not.toContain("GMAIL_CLIENT_SECRET");
  });
});
