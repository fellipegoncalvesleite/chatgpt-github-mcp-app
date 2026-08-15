import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { describe, expect, it, vi } from "vitest";
import { AuditLogger } from "../src/audit.js";
import type { AppConfig } from "../src/config.js";
import type { LocalToolGateway } from "../src/local/gateway.js";
import { createGitHubMcpServer } from "../src/mcp.js";
import { fakeGitHubService, testConfig } from "./helpers.js";

function fakeLocalGateway(): LocalToolGateway {
  return {
    status() {
      return {
        configured: true,
        connected: true,
        agentId: "mac-test",
        lastSeenAt: new Date().toISOString(),
        queuedRequests: 0,
        pendingRequests: 0,
      };
    },
    async request(method, params) {
      return { method, params, hostname: "test-mac" };
    },
  };
}

async function connectedClient(
  scopes: string[],
  overrides: Partial<AppConfig> = {},
  localGateway?: LocalToolGateway,
) {
  const directory = await mkdtemp(join(tmpdir(), "github-mcp-test-"));
  const config = testConfig({ auditLogPath: join(directory, "audit.jsonl"), ...overrides });
  const github = fakeGitHubService();
  const server = createGitHubMcpServer({
    config,
    github,
    audit: new AuditLogger(config.auditLogPath),
    ...(localGateway === undefined ? {} : { localGateway }),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const originalSend = clientTransport.send.bind(clientTransport);
  const authInfo: AuthInfo = {
    token: "test-token",
    clientId: "test-client",
    scopes,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    resource: new URL("http://localhost:3000/mcp"),
    extra: { subject: "test-user" },
  };
  clientTransport.send = (message, options) => originalSend(message, { ...options, authInfo });
  await server.connect(serverTransport as never);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(clientTransport as never);
  return { client, server, github, config };
}

describe("GitHub MCP tools", () => {
  it("registers safe default tools and hides disabled dangerous tools", async () => {
    const { client, server } = await connectedClient(["github:read", "github:write"]);
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain("github_read_file");
    expect(names).toContain("github_create_change");
    expect(names).not.toContain("github_merge_pull_request");
    expect(names).not.toContain("github_delete_branch");
    await client.close();
    await server.close();
  });

  it("reads a file when github:read is granted", async () => {
    const { client, server } = await connectedClient(["github:read"]);
    const result = await client.callTool({
      name: "github_read_file",
      arguments: { repository: "acme/demo", path: "README.md" },
    });
    expect(result.isError).not.toBe(true);
    expect((result.content as Array<unknown>)[0]).toMatchObject({ type: "text" });
    expect(JSON.stringify(result.structuredContent)).toContain("hello");
    await client.close();
    await server.close();
  });

  it("denies writes without github:write", async () => {
    const createChange = vi.fn(fakeGitHubService().createChange);
    const directory = await mkdtemp(join(tmpdir(), "github-mcp-test-"));
    const config = testConfig({ auditLogPath: join(directory, "audit.jsonl") });
    const github = fakeGitHubService({ createChange });
    const server = createGitHubMcpServer({ config, github, audit: new AuditLogger(config.auditLogPath) });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const originalSend = clientTransport.send.bind(clientTransport);
    clientTransport.send = (message, options) => originalSend(message, {
      ...options,
      authInfo: {
        token: "test-token",
        clientId: "test-client",
        scopes: ["github:read"],
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        resource: new URL("http://localhost:3000/mcp"),
      },
    });
    await server.connect(serverTransport as never);
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(clientTransport as never);
    const result = await client.callTool({
      name: "github_create_change",
      arguments: {
        repository: "acme/demo",
        commitMessage: "Update README",
        changes: [{ path: "README.md", operation: "upsert", content: "new" }],
      },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.structuredContent)).toContain("insufficient_scope");
    expect(createChange).not.toHaveBeenCalled();
    await client.close();
    await server.close();
  });

  it("registers local tools and enforces local OAuth scopes", async () => {
    const gateway = fakeLocalGateway();
    const withoutLocalScope = await connectedClient(["github:read"], {}, gateway);
    const names = (await withoutLocalScope.client.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain("local_get_info");
    expect(names).toContain("local_run");

    const denied = await withoutLocalScope.client.callTool({ name: "local_get_info", arguments: {} });
    expect(denied.isError).toBe(true);
    expect(JSON.stringify(denied.structuredContent)).toContain("local:read");
    await withoutLocalScope.client.close();
    await withoutLocalScope.server.close();

    const withLocalScope = await connectedClient(["local:read", "local:write"], {}, gateway);
    const info = await withLocalScope.client.callTool({ name: "local_get_info", arguments: {} });
    expect(info.isError).not.toBe(true);
    expect(JSON.stringify(info.structuredContent)).toContain("test-mac");

    const run = await withLocalScope.client.callTool({
      name: "local_run",
      arguments: { command: "pwd", cwd: "/tmp" },
    });
    expect(run.isError).not.toBe(true);
    expect(JSON.stringify(run.structuredContent)).toContain("shell.run");
    await withLocalScope.client.close();
    await withLocalScope.server.close();
  });
});
