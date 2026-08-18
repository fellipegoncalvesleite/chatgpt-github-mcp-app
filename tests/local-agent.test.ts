import { describe, expect, it } from "vitest";
import { runAgentCycle, type LocalAgentRuntimeConfig } from "../src/local/agent.js";
import type { LocalExecutionServices } from "../src/local/dispatcher.js";
import { TerminalManager } from "../src/local/terminal.js";

describe("Mac local agent", () => {
  it("polls work, executes it, and posts the correlated response", async () => {
    const config: LocalAgentRuntimeConfig = {
      gatewayUrl: new URL("https://gateway.example.com"),
      token: "secret",
      agentId: "mac-test",
      pollWaitMs: 100,
      maxOutputBytes: 100_000,
      maxFileBytes: 100_000,
      maxTerminalBytes: 100_000,
      maxSessions: 4,
      maxCommandTimeoutMs: 5_000,
      maxScreenshotBytes: 1_500_000,
      maxScreenshotEdge: 1600,
    };
    const services: LocalExecutionServices = {
      terminal: new TerminalManager({ maxBufferBytes: 100_000, maxSessions: 4, shell: "/bin/sh" }),
      maxOutputBytes: 100_000,
      maxFileBytes: 100_000,
      maxCommandTimeoutMs: 5_000,
    };

    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, ...(init === undefined ? {} : { init }) });
      if (url.endsWith("/local-agent/poll")) {
        return new Response(JSON.stringify({
          type: "request",
          id: "request-1",
          method: "system.info",
          params: {},
          createdAt: Date.now(),
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    await expect(runAgentCycle(config, services, fetchImpl)).resolves.toBe(true);
    expect(requests).toHaveLength(2);
    expect(requests[0]?.url).toContain("/local-agent/poll");
    expect(requests[1]?.url).toContain("/local-agent/respond");
    const responseBody = JSON.parse(String(requests[1]?.init?.body)) as { response: { id: string; ok: boolean; result: unknown } };
    expect(responseBody.response.id).toBe("request-1");
    expect(responseBody.response.ok).toBe(true);
    expect(JSON.stringify(responseBody.response.result)).toContain("nodeVersion");
    services.terminal.closeAll();
  });

  it("retries the same completed response after transient delivery failures", async () => {
    const config: LocalAgentRuntimeConfig = {
      gatewayUrl: new URL("https://gateway.example.com"),
      token: "secret",
      agentId: "mac-test",
      pollWaitMs: 100,
      maxOutputBytes: 100_000,
      maxFileBytes: 100_000,
      maxTerminalBytes: 100_000,
      maxSessions: 4,
      maxCommandTimeoutMs: 5_000,
      maxScreenshotBytes: 1_500_000,
      maxScreenshotEdge: 1600,
    };
    const services: LocalExecutionServices = {
      terminal: new TerminalManager({ maxBufferBytes: 100_000, maxSessions: 4, shell: "/bin/sh" }),
      maxOutputBytes: 100_000,
      maxFileBytes: 100_000,
      maxCommandTimeoutMs: 5_000,
    };

    const requests: Array<{ url: string; init?: RequestInit }> = [];
    let responseAttempts = 0;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, ...(init === undefined ? {} : { init }) });
      if (url.endsWith("/local-agent/poll")) {
        return new Response(JSON.stringify({
          type: "request",
          id: "request-retry",
          method: "system.info",
          params: {},
          createdAt: Date.now(),
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      responseAttempts += 1;
      if (responseAttempts === 1) throw new TypeError("fetch failed");
      if (responseAttempts === 2) return new Response("temporarily unavailable", { status: 503 });
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    await expect(runAgentCycle(config, services, fetchImpl)).resolves.toBe(true);
    expect(requests.filter((request) => request.url.endsWith("/local-agent/poll"))).toHaveLength(1);
    const responseRequests = requests.filter((request) => request.url.endsWith("/local-agent/respond"));
    expect(responseRequests).toHaveLength(3);
    expect(new Set(responseRequests.map((request) => String(request.init?.body))).size).toBe(1);
    services.terminal.closeAll();
  });

  it("does not retry permanent response-delivery failures", async () => {
    const config: LocalAgentRuntimeConfig = {
      gatewayUrl: new URL("https://gateway.example.com"),
      token: "secret",
      agentId: "mac-test",
      pollWaitMs: 100,
      maxOutputBytes: 100_000,
      maxFileBytes: 100_000,
      maxTerminalBytes: 100_000,
      maxSessions: 4,
      maxCommandTimeoutMs: 5_000,
      maxScreenshotBytes: 1_500_000,
      maxScreenshotEdge: 1600,
    };
    const services: LocalExecutionServices = {
      terminal: new TerminalManager({ maxBufferBytes: 100_000, maxSessions: 4, shell: "/bin/sh" }),
      maxOutputBytes: 100_000,
      maxFileBytes: 100_000,
      maxCommandTimeoutMs: 5_000,
    };

    const requests: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith("/local-agent/poll")) {
        return new Response(JSON.stringify({
          type: "request",
          id: "request-permanent-failure",
          method: "system.info",
          params: {},
          createdAt: Date.now(),
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response("gone", { status: 404 });
    }) as typeof fetch;

    await expect(runAgentCycle(config, services, fetchImpl)).rejects.toThrow(/HTTP 404/);
    expect(requests.filter((url) => url.endsWith("/local-agent/respond"))).toHaveLength(1);
    services.terminal.closeAll();
  });
});
