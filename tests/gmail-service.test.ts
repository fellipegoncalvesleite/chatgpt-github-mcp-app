import { describe, expect, it, vi } from "vitest";
import { AppError } from "../src/errors.js";
import { composeTextMessage, decodeBase64Url, extractMessageView } from "../src/gmail/mime.js";
import { GmailService, GoogleTokenProvider } from "../src/gmail/service.js";

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function apiMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: "m1",
    threadId: "t1",
    labelIds: ["INBOX", "UNREAD"],
    snippet: "hello snippet",
    internalDate: "1720000000000",
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: "Alice <alice@example.com>" },
        { name: "To", value: "owner@example.com" },
        { name: "Subject", value: "Hello" },
        { name: "Date", value: "Fri, 2 Aug 2026 12:00:00 +0000" },
        { name: "Message-ID", value: "<message-1@example.com>" },
      ],
      body: { data: Buffer.from("Plain body", "utf8").toString("base64url") },
    },
    ...overrides,
  };
}

describe("Gmail MIME helpers", () => {
  it("composes a UTF-8 text message as Gmail base64url", () => {
    const raw = composeTextMessage({
      to: ["alice@example.com", "Bob <bob@example.com>"],
      cc: ["cc@example.com"],
      bcc: ["hidden@example.com"],
      subject: "Olá ✓",
      bodyText: "Olá, mundo!\nSecond line.",
    });
    const decoded = decodeBase64Url(raw);
    expect(decoded).toContain("To: alice@example.com, Bob <bob@example.com>\r\n");
    expect(decoded).toContain("Cc: cc@example.com\r\n");
    expect(decoded).toContain("Bcc: hidden@example.com\r\n");
    expect(decoded).toContain("Subject: =?UTF-8?B?");
    expect(decoded).toContain("Content-Type: text/plain; charset=UTF-8\r\n");
    expect(decoded.endsWith("Olá, mundo!\r\nSecond line.")).toBe(true);
  });

  it("rejects header injection", () => {
    expect(() => composeTextMessage({
      to: ["alice@example.com\r\nBcc: attacker@example.com"],
      subject: "hello",
      bodyText: "body",
    })).toThrow(/header/i);
    expect(() => composeTextMessage({
      to: ["alice@example.com"],
      subject: "hello\nBcc: attacker@example.com",
      bodyText: "body",
    })).toThrow(/header/i);
  });

  it("extracts text and html bodies recursively from multipart messages", () => {
    const view = extractMessageView(apiMessage({
      payload: {
        mimeType: "multipart/alternative",
        headers: apiMessage().payload.headers,
        parts: [
          { mimeType: "text/plain", body: { data: Buffer.from("plain").toString("base64url") } },
          { mimeType: "text/html", body: { data: Buffer.from("<p>html</p>").toString("base64url") } },
        ],
      },
    }));
    expect(view).toMatchObject({
      id: "m1",
      threadId: "t1",
      from: "Alice <alice@example.com>",
      to: "owner@example.com",
      subject: "Hello",
      textBody: "plain",
      htmlBody: "<p>html</p>",
    });
  });
});

describe("GoogleTokenProvider", () => {
  it("exchanges the refresh token and caches access tokens", async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = String(init?.body ?? "");
      expect(body).toContain("grant_type=refresh_token");
      expect(body).toContain("refresh_token=refresh-token");
      return jsonResponse({ access_token: "access-1", expires_in: 3600, token_type: "Bearer" });
    });
    const provider = new GoogleTokenProvider({
      clientId: "client-id",
      clientSecret: "client-secret",
      refreshToken: "refresh-token",
      fetchImpl: fetchImpl as typeof fetch,
      now: () => 1_000_000,
    });

    await expect(provider.getAccessToken()).resolves.toBe("access-1");
    await expect(provider.getAccessToken()).resolves.toBe("access-1");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not leak raw OAuth responses when token refresh fails", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "invalid_grant", secret: "DO_NOT_LEAK" }, 400));
    const provider = new GoogleTokenProvider({
      clientId: "client-id",
      clientSecret: "client-secret",
      refreshToken: "refresh-token",
      fetchImpl: fetchImpl as typeof fetch,
    });
    await expect(provider.getAccessToken()).rejects.toMatchObject({ code: "gmail_auth_failed" });
    try {
      await provider.getAccessToken(true);
    } catch (error) {
      expect(String(error)).not.toContain("DO_NOT_LEAK");
    }
  });
});

describe("GmailService", () => {
  function serviceWith(fetchImpl: typeof fetch) {
    return new GmailService({
      accountEmail: "owner@example.com",
      tokenProvider: { getAccessToken: vi.fn(async () => "access-token") },
      fetchImpl,
    });
  }

  it("fails closed when the authorized mailbox does not match configuration", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ emailAddress: "other@example.com", messagesTotal: 1, threadsTotal: 1, historyId: "1" }));
    const service = serviceWith(fetchImpl as typeof fetch);
    await expect(service.getProfile()).rejects.toMatchObject({ code: "gmail_account_mismatch" });
  });

  it("searches with Gmail query syntax and hydrates bounded metadata", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/profile")) return jsonResponse({ emailAddress: "owner@example.com", messagesTotal: 10, threadsTotal: 5, historyId: "7" });
      if (url.includes("/messages?") && !url.includes("format=")) {
        return jsonResponse({ messages: [{ id: "m1", threadId: "t1" }], nextPageToken: "next", resultSizeEstimate: 1 });
      }
      if (url.includes("/messages/m1?")) return jsonResponse(apiMessage());
      throw new Error(`unexpected ${url}`);
    });
    const service = serviceWith(fetchImpl as typeof fetch);
    const result = await service.searchMessages({ query: "from:alice@example.com newer_than:7d", maxResults: 20 });
    expect(result.nextPageToken).toBe("next");
    expect(result.messages[0]).toMatchObject({ id: "m1", subject: "Hello", from: "Alice <alice@example.com>" });
    expect(calls.some((url) => url.includes("q=from%3Aalice%40example.com+newer_than%3A7d"))).toBe(true);
    expect(calls.some((url) => url.includes("maxResults=20"))).toBe(true);
  });

  it("retries one Gmail 401 with a forced token refresh", async () => {
    const tokenProvider = { getAccessToken: vi.fn(async (force?: boolean) => force ? "access-2" : "access-1") };
    let profileAttempts = 0;
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      profileAttempts += 1;
      if (profileAttempts === 1) return jsonResponse({ error: "expired" }, 401);
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer access-2");
      return jsonResponse({ emailAddress: "owner@example.com", messagesTotal: 1, threadsTotal: 1, historyId: "1" });
    });
    const service = new GmailService({ accountEmail: "owner@example.com", tokenProvider, fetchImpl: fetchImpl as typeof fetch });
    await expect(service.getProfile()).resolves.toMatchObject({ emailAddress: "owner@example.com" });
    expect(tokenProvider.getAccessToken).toHaveBeenLastCalledWith(true);
  });

  it("reads full messages and lists labels", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/profile")) return jsonResponse({ emailAddress: "owner@example.com", messagesTotal: 1, threadsTotal: 1, historyId: "1" });
      if (url.includes("/messages/m1?format=full")) return jsonResponse(apiMessage());
      if (url.endsWith("/labels")) return jsonResponse({ labels: [{ id: "INBOX", name: "INBOX", type: "system" }, { id: "Label_1", name: "Work", type: "user" }] });
      throw new Error(`unexpected ${url}`);
    });
    const service = serviceWith(fetchImpl as typeof fetch);
    await expect(service.readMessage("m1")).resolves.toMatchObject({ id: "m1", textBody: "Plain body" });
    await expect(service.listLabels()).resolves.toEqual([
      { id: "INBOX", name: "INBOX", type: "system" },
      { id: "Label_1", name: "Work", type: "user" },
    ]);
  });

  it("creates, reads, lists, and sends drafts", async () => {
    const seen: Array<{ url: string; method: string; body?: unknown }> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      seen.push({ url, method, body });
      if (url.endsWith("/profile")) return jsonResponse({ emailAddress: "owner@example.com", messagesTotal: 1, threadsTotal: 1, historyId: "1" });
      if (url.endsWith("/drafts") && method === "POST") return jsonResponse({ id: "d1", message: { id: "dm1", threadId: "dt1" } });
      if (url.includes("/drafts?")) return jsonResponse({ drafts: [{ id: "d1", message: { id: "dm1", threadId: "dt1" } }], resultSizeEstimate: 1 });
      if (url.includes("/drafts/d1?format=full")) return jsonResponse({ id: "d1", message: apiMessage({ id: "dm1", threadId: "dt1" }) });
      if (url.endsWith("/drafts/send") && method === "POST") return jsonResponse(apiMessage({ id: "sent1", threadId: "dt1" }));
      throw new Error(`unexpected ${method} ${url}`);
    });
    const service = serviceWith(fetchImpl as typeof fetch);

    await expect(service.createDraft({ to: ["alice@example.com"], subject: "Draft", bodyText: "Body" }))
      .resolves.toMatchObject({ id: "d1" });
    await expect(service.listDrafts({ maxResults: 20 })).resolves.toMatchObject({ drafts: [{ id: "d1" }] });
    await expect(service.readDraft("d1")).resolves.toMatchObject({ id: "d1", message: { id: "dm1", textBody: "Plain body" } });
    await expect(service.sendDraft("d1")).resolves.toMatchObject({ id: "sent1" });

    const createCall = seen.find((call) => call.url.endsWith("/drafts") && call.method === "POST");
    expect((createCall?.body as { message?: { raw?: string } }).message?.raw).toBeTruthy();
  });

  it("sends new messages, archives only by removing INBOX, and changes labels in batch", async () => {
    const seen: Array<{ url: string; method: string; body?: unknown }> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      seen.push({ url, method, body });
      if (url.endsWith("/profile")) return jsonResponse({ emailAddress: "owner@example.com", messagesTotal: 1, threadsTotal: 1, historyId: "1" });
      if (url.endsWith("/messages/send")) return jsonResponse({ id: "sent1", threadId: "t1", labelIds: ["SENT"] });
      if (url.endsWith("/messages/batchModify")) return new Response(null, { status: 204 });
      throw new Error(`unexpected ${method} ${url}`);
    });
    const service = serviceWith(fetchImpl as typeof fetch);

    await expect(service.sendMessage({ to: ["alice@example.com"], subject: "Hi", bodyText: "Body" }))
      .resolves.toMatchObject({ id: "sent1" });
    await service.archiveMessages(["m1", "m2"]);
    await service.modifyLabels(["m1"], ["Label_1"], ["UNREAD"]);

    const batchBodies = seen.filter((call) => call.url.endsWith("/messages/batchModify")).map((call) => call.body);
    expect(batchBodies).toContainEqual({ ids: ["m1", "m2"], removeLabelIds: ["INBOX"] });
    expect(batchBodies).toContainEqual({ ids: ["m1"], addLabelIds: ["Label_1"], removeLabelIds: ["UNREAD"] });
  });

  it("rejects attempts to manipulate TRASH through generic label mutation", async () => {
    const service = serviceWith(vi.fn() as unknown as typeof fetch);
    await expect(service.modifyLabels(["m1"], ["TRASH"], [])).rejects.toBeInstanceOf(AppError);
    await expect(service.modifyLabels(["m1"], ["TRASH"], [])).rejects.toMatchObject({ code: "gmail_forbidden_label" });
  });
});
