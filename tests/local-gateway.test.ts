import { describe, expect, it } from "vitest";
import { LocalAgentGateway } from "../src/local/gateway.js";
import { testConfig } from "./helpers.js";

describe("LocalAgentGateway", () => {
  it("authenticates the local-agent token without exposing it", () => {
    const config = testConfig();
    const gateway = new LocalAgentGateway(config);
    expect(() => gateway.assertToken(config.localAgentToken)).not.toThrow();
    expect(() => gateway.assertToken("wrong-token")).toThrow(/authentication failed/i);
    expect(JSON.stringify(gateway.status())).not.toContain(config.localAgentToken);
  });

  it("correlates one queued request with one agent response", async () => {
    const config = testConfig({ localAgentPollWaitMs: 1_000 });
    const gateway = new LocalAgentGateway(config);

    await gateway.poll("mac-1", 0);
    const resultPromise = gateway.request("system.info", {});

    const work = await gateway.poll("mac-1", 10);
    expect(work?.method).toBe("system.info");
    expect(work?.id).toBeTruthy();

    gateway.respond("mac-1", {
      type: "response",
      id: work!.id,
      ok: true,
      result: { hostname: "test-mac" },
    });

    await expect(resultPromise).resolves.toEqual({ hostname: "test-mac" });
    expect(gateway.status().connected).toBe(true);
  });

  it("accepts a duplicate response when the first acknowledgement was lost", async () => {
    const config = testConfig({ localAgentPollWaitMs: 1_000 });
    const gateway = new LocalAgentGateway(config);

    await gateway.poll("mac-1", 0);
    const resultPromise = gateway.request("system.info", {});
    const work = await gateway.poll("mac-1", 10);
    const response = {
      type: "response" as const,
      id: work!.id,
      ok: true as const,
      result: { hostname: "test-mac" },
    };

    gateway.respond("mac-1", response);
    await expect(resultPromise).resolves.toEqual({ hostname: "test-mac" });
    expect(() => gateway.respond("mac-1", response)).not.toThrow();
  });

  it("returns stable agent errors to the pending request", async () => {
    const config = testConfig();
    const gateway = new LocalAgentGateway(config);
    await gateway.poll("mac-1", 0);

    const resultPromise = gateway.request("fs.read", { path: "/missing" });
    const work = await gateway.poll("mac-1", 10);
    gateway.respond("mac-1", {
      type: "response",
      id: work!.id,
      ok: false,
      error: { code: "enoent", message: "no such file" },
    });

    await expect(resultPromise).rejects.toMatchObject({ code: "enoent" });
  });

  it("reports not configured when the gateway has no local token", async () => {
    const gateway = new LocalAgentGateway(testConfig({ localAgentToken: "" }));
    expect(gateway.status()).toMatchObject({ configured: false, connected: false });
    await expect(gateway.request("system.info", {})).rejects.toMatchObject({ code: "agent_not_configured" });
  });
});
