import { readFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { describe, expect, it, vi } from "vitest";
import { AuditLogger } from "../src/audit.js";
import type { GmailToolService } from "../src/gmail/mcp-tools.js";
import { createGitHubMcpServer } from "../src/mcp.js";
import { fakeGitHubService, testConfig } from "./helpers.js";

function fakeGmailService(): GmailToolService {
  return {
    getProfile: vi.fn(async () => ({ emailAddress: "owner@example.com" })),
    searchMessages: vi.fn(async () => ({
      messages: [{ id: "m1", threadId: "t1", labelIds: ["INBOX"], snippet: "snippet", internalDate: "1", from: "Alice", to: "owner@example.com", cc: "", bcc: "", subject: "Private subject", date: "today", messageIdHeader: "", textBody: "", htmlBody: "" }],
      nextPageToken: "",
      resultSizeEstimate: 1,
    })),
    readMessage: vi.fn(async () => ({ id: "m1", threadId: "t1", labelIds: [], snippet: "", internalDate: "", from: "Alice", to: "owner@example.com", cc: "", bcc: "", subject: "Private subject", date: "", messageIdHeader: "", textBody: "secret body", htmlBody: "" })),
    listLabels: vi.fn(async () => [{ id: "INBOX", name: "INBOX", type: "system" }]),
    listDrafts: vi.fn(async () => ({ drafts: [{ id: "d1", messageId: "m2", threadId: "t2" }], nextPageToken: "", resultSizeEstimate: 1 })),
    readDraft: vi.fn(async () => ({ id: "d1", message: { id: "m2", threadId: "t2", labelIds: ["DRAFT"], snippet: "", internalDate: "", from: "", to: "alice@example.com", cc: "", bcc: "", subject: "Draft subject", date: "", messageIdHeader: "", textBody: "draft secret", htmlBody: "" } })),
    createDraft: vi.fn(async () => ({ id: "d2", messageId: "m3", threadId: "t3" })),
    sendMessage: vi.fn(async () => ({ id: "m4", threadId: "t4", labelIds: ["SENT"] })),
    sendDraft: vi.fn(async () => ({ id: "m5", threadId: "t5", labelIds: ["SENT"] })),
    archiveMessages: vi.fn(async (ids: string[]) => ({ archived: ids.length })),
    modifyLabels: vi.fn(async (ids: string[]) => ({ modified: ids.length })),
  };
}

async function connected(scopes: string[], gmail?: GmailToolService) {
  const directory = await mkdtemp(join(tmpdir(), "gmail-mcp-test-"));
  const config = testConfig({ auditLogPath: join(directory, "audit.jsonl") });
  const audit = new AuditLogger(config.auditLogPath);
  const server = createGitHubMcpServer({
    config,
    github: fakeGitHubService(),
    audit,
    ...(gmail ? { gmail } : {}),
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
  const client = new Client({ name: "test-client", version: "1" });
  await client.connect(clientTransport as never);
  return { client, server, config };
}

describe("Gmail MCP tools", () => {
  it("does not register Gmail tools without a configured Gmail service", async () => {
    const { client, server } = await connected(["github:read"]);
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names.some((name) => name.startsWith("gmail_"))).toBe(false);
    await client.close();
    await server.close();
  });

  it("registers the exact v1 Gmail tool surface", async () => {
    const { client, server } = await connected(["gmail:read", "gmail:write"], fakeGmailService());
    const names = (await client.listTools()).tools.map((tool) => tool.name).filter((name) => name.startsWith("gmail_")).sort();
    expect(names).toEqual([
      "gmail_archive_messages",
      "gmail_create_draft",
      "gmail_get_profile",
      "gmail_list_drafts",
      "gmail_list_labels",
      "gmail_modify_labels",
      "gmail_read_draft",
      "gmail_read_message",
      "gmail_search_messages",
      "gmail_send_draft",
      "gmail_send_message",
    ]);
    expect(names).not.toContain("gmail_trash_message");
    expect(names).not.toContain("gmail_delete_message");
    await client.close();
    await server.close();
  });

  it("enforces gmail:read on read tools", async () => {
    const gmail = fakeGmailService();
    const { client, server } = await connected(["gmail:write"], gmail);
    const result = await client.callTool({ name: "gmail_read_message", arguments: { messageId: "m1" } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.structuredContent)).toContain("gmail:read");
    expect(gmail.readMessage).not.toHaveBeenCalled();
    await client.close();
    await server.close();
  });

  it("enforces gmail:write on write tools", async () => {
    const gmail = fakeGmailService();
    const { client, server } = await connected(["gmail:read"], gmail);
    const result = await client.callTool({
      name: "gmail_send_message",
      arguments: { to: ["alice@example.com"], subject: "Hello", bodyText: "secret body" },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.structuredContent)).toContain("gmail:write");
    expect(gmail.sendMessage).not.toHaveBeenCalled();
    await client.close();
    await server.close();
  });

  it("calls Gmail and audits without message content, subject, recipients, or query", async () => {
    const gmail = fakeGmailService();
    const { client, server, config } = await connected(["gmail:read", "gmail:write"], gmail);
    const searched = await client.callTool({
      name: "gmail_search_messages",
      arguments: { query: "from:private@example.com subject:secret", maxResults: 10 },
    });
    expect(searched.isError).not.toBe(true);
    expect(JSON.stringify(searched.structuredContent)).toContain("Private subject");

    const sent = await client.callTool({
      name: "gmail_send_message",
      arguments: { to: ["private@example.com"], subject: "secret subject", bodyText: "secret body" },
    });
    expect(sent.isError).not.toBe(true);

    const auditText = await readFile(config.auditLogPath, "utf8");
    expect(auditText).toContain("gmail_search_messages");
    expect(auditText).toContain("gmail_send_message");
    expect(auditText).not.toContain("private@example.com");
    expect(auditText).not.toContain("secret subject");
    expect(auditText).not.toContain("secret body");
    expect(auditText).not.toContain("subject:secret");
    await client.close();
    await server.close();
  });


  it("does not expose unexpected Gmail dependency errors", async () => {
    const gmail = fakeGmailService();
    gmail.readMessage = vi.fn(async () => { throw new Error("RAW_PRIVATE_UPSTREAM_DETAIL"); });
    const { client, server } = await connected(["gmail:read"], gmail);
    const result = await client.callTool({ name: "gmail_read_message", arguments: { messageId: "m1" } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("Unexpected Gmail tool failure");
    expect(JSON.stringify(result)).not.toContain("RAW_PRIVATE_UPSTREAM_DETAIL");
    await client.close();
    await server.close();
  });

  it("passes bounded Gmail write arguments to the service", async () => {
    const gmail = fakeGmailService();
    const { client, server } = await connected(["gmail:write"], gmail);
    await client.callTool({ name: "gmail_archive_messages", arguments: { messageIds: ["m1", "m2"] } });
    expect(gmail.archiveMessages).toHaveBeenCalledWith(["m1", "m2"]);

    await client.callTool({
      name: "gmail_modify_labels",
      arguments: { messageIds: ["m1"], addLabelIds: ["Label_1"], removeLabelIds: ["UNREAD"] },
    });
    expect(gmail.modifyLabels).toHaveBeenCalledWith(["m1"], ["Label_1"], ["UNREAD"]);
    await client.close();
    await server.close();
  });
});
