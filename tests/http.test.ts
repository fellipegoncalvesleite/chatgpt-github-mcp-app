import { createHash } from "node:crypto";
import { rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { AuditLogger } from "../src/audit.js";
import { SingleUserOAuthProvider } from "../src/oauth/provider.js";
import { createApp } from "../src/server.js";
import { fakeGitHubService, testConfig } from "./helpers.js";

const created: string[] = [];
afterEach(async () => {
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function testApp() {
  const directory = await mkdtemp(join(tmpdir(), "github-mcp-http-test-"));
  created.push(directory);
  const config = testConfig({
    oauthStorePath: join(directory, "oauth.json"),
    auditLogPath: join(directory, "audit.jsonl"),
  });
  return {
    config,
    app: createApp({
      config,
      github: fakeGitHubService(),
      audit: new AuditLogger(config.auditLogPath),
      oauth: new SingleUserOAuthProvider(config),
    }),
  };
}

describe("HTTP/OAuth surface", () => {
  it("serves health and OAuth protected resource metadata", async () => {
    const { app } = await testApp();
    await request(app).get("/healthz").set("Host", "localhost").expect(200, /ok/);
    const metadata = await request(app)
      .get("/.well-known/oauth-protected-resource/mcp")
      .set("Host", "localhost")
      .expect(200);
    expect(metadata.body.resource).toBe("http://localhost:3000/mcp");
    expect(metadata.body.authorization_servers).toContain("http://localhost:3000/");
  });

  it("returns OAuth discovery information on unauthenticated MCP access", async () => {
    const { app } = await testApp();
    const response = await request(app)
      .post("/mcp")
      .set("Host", "localhost")
      .send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } })
      .expect(401);
    expect(response.headers["www-authenticate"]).toContain("oauth-protected-resource/mcp");
  });

  it("completes dynamic registration, PKCE authorization, token exchange, and refresh rotation", async () => {
    const { app } = await testApp();
    const callback = "https://chatgpt.com/aip/oauth/callback";
    const registered = await request(app)
      .post("/register")
      .set("Host", "localhost")
      .send({
        client_name: "ChatGPT test client",
        redirect_uris: [callback],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      })
      .expect(201);

    const verifier = "v".repeat(64);
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const authorize = await request(app)
      .get("/authorize")
      .set("Host", "localhost")
      .query({
        response_type: "code",
        client_id: registered.body.client_id,
        redirect_uri: callback,
        code_challenge: challenge,
        code_challenge_method: "S256",
        scope: "github:read github:write",
        resource: "http://localhost:3000/mcp",
        state: "state-1",
      })
      .expect(302);
    const approvalLocation = authorize.headers.location;
    expect(approvalLocation).toBeTruthy();
    const approvalUrl = new URL(approvalLocation!, "http://localhost:3000");
    const requestId = approvalUrl.searchParams.get("request_id");
    expect(requestId).toBeTruthy();

    const approved = await request(app)
      .post("/oauth/approve")
      .set("Host", "localhost")
      .type("form")
      .send({ request_id: requestId, password: "test-password", action: "approve" })
      .expect(302);
    const callbackLocation = approved.headers.location;
    expect(callbackLocation).toBeTruthy();
    const callbackUrl = new URL(callbackLocation!);
    expect(callbackUrl.searchParams.get("state")).toBe("state-1");
    const code = callbackUrl.searchParams.get("code");
    expect(code).toBeTruthy();

    const tokens = await request(app)
      .post("/token")
      .set("Host", "localhost")
      .type("form")
      .send({
        grant_type: "authorization_code",
        client_id: registered.body.client_id,
        code,
        code_verifier: verifier,
        redirect_uri: callback,
        resource: "http://localhost:3000/mcp",
      })
      .expect(200);
    expect(tokens.body.access_token).toBeTruthy();
    expect(tokens.body.refresh_token).toBeTruthy();

    const initialized = await request(app)
      .post("/mcp")
      .set("Host", "localhost")
      .set("Authorization", `Bearer ${tokens.body.access_token}`)
      .set("Accept", "application/json, text/event-stream")
      .send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
      })
      .expect(200);
    expect(initialized.text).toContain("chatgpt-github-write-bridge");

    const tools = await request(app)
      .post("/mcp")
      .set("Host", "localhost")
      .set("Authorization", `Bearer ${tokens.body.access_token}`)
      .set("Accept", "application/json, text/event-stream")
      .send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })
      .expect(200);
    expect(tools.text).toContain("github_create_change");

    const refreshed = await request(app)
      .post("/token")
      .set("Host", "localhost")
      .type("form")
      .send({
        grant_type: "refresh_token",
        client_id: registered.body.client_id,
        refresh_token: tokens.body.refresh_token,
        resource: "http://localhost:3000/mcp",
      })
      .expect(200);
    expect(refreshed.body.refresh_token).not.toBe(tokens.body.refresh_token);

    await request(app)
      .post("/token")
      .set("Host", "localhost")
      .type("form")
      .send({
        grant_type: "refresh_token",
        client_id: registered.body.client_id,
        refresh_token: tokens.body.refresh_token,
        resource: "http://localhost:3000/mcp",
      })
      .expect(400);
  });
});
