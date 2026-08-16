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
    expect(names).toContain("local_get_project_context");
    expect(names).toContain("local_code_search");
    expect(names).toContain("local_git_review");
    expect(names).toContain("local_get_ui_context");
    expect(names).toContain("local_capture_screen");

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

describe("development workflow", () => {
  it("publishes inspect-first, AGENTS, testing, and final-verification instructions", async () => {
    const { client, server } = await connectedClient(["github:read"]);
    const instructions = client.getInstructions() ?? "";

    expect(instructions).toMatch(/inspect before edit/i);
    expect(instructions).toMatch(/AGENTS\.override\.md/);
    expect(instructions).toMatch(/AGENTS\.md/);
    expect(instructions).toMatch(/plan non-trivial/i);
    expect(instructions).toMatch(/test after edit/i);
    expect(instructions).toMatch(/inspect (the )?final Git state|review (the )?final Git/i);
    expect(instructions).toMatch(/verify before claiming completion/i);

    await client.close();
    await server.close();
  });

  it("registers development_workflow while keeping safe_github_development", async () => {
    const { client, server } = await connectedClient(["github:read"]);
    const prompts = (await client.listPrompts()).prompts.map((prompt) => prompt.name);

    expect(prompts).toContain("safe_github_development");
    expect(prompts).toContain("development_workflow");

    const prompt = await client.getPrompt({
      name: "development_workflow",
      arguments: {
        repository: "acme/demo",
        task: "Fix the parser without changing unrelated behavior",
        workingDirectory: "/tmp/demo",
      },
    });
    const text = JSON.stringify(prompt.messages);
    expect(text).toContain("acme/demo");
    expect(text).toContain("Fix the parser without changing unrelated behavior");
    expect(text).toContain("/tmp/demo");
    expect(text).toMatch(/AGENTS/);
    expect(text).toMatch(/targeted tests/i);
    expect(text).toMatch(/Git state|git review/i);

    await client.close();
    await server.close();
  });
});


describe("visual MCP transport", () => {
  it("returns screenshot bytes as an MCP image block without duplicating base64 in structured content", async () => {
    const imageBase64 = Buffer.from("fake-png-bytes").toString("base64");
    const gateway: LocalToolGateway = {
      status() {
        return { configured: true, connected: true, agentId: "mac-test", lastSeenAt: new Date().toISOString(), queuedRequests: 0, pendingRequests: 0 };
      },
      async request(method) {
        if (method === "visual.captureScreen") {
          return {
            imageBase64,
            mimeType: "image/png",
            display: "main",
            width: 1200,
            height: 800,
            byteLength: 14,
          };
        }
        return {};
      },
    };
    const { client, server } = await connectedClient(["local:read"], {}, gateway);

    const result = await client.callTool({
      name: "local_capture_screen",
      arguments: { display: "main", includeCursor: false, maxEdge: 1600 },
    });

    expect(result.isError).not.toBe(true);
    expect(result.content).toEqual([
      { type: "image", data: imageBase64, mimeType: "image/png" },
    ]);
    expect(JSON.stringify(result.structuredContent)).not.toContain(imageBase64);
    expect(result.structuredContent).toMatchObject({
      display: "main",
      width: 1200,
      height: 800,
      byteLength: 14,
      mimeType: "image/png",
    });

    await client.close();
    await server.close();
  });
});
