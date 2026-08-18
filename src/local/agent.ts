import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { pathToFileURL } from "node:url";
import { dispatchLocalRequest, type LocalExecutionServices } from "./dispatcher.js";
import {
  isLocalRpcRequest,
  toLocalRpcErrorResponse,
  toLocalRpcResponse,
  type LocalRpcRequest,
  type LocalRpcResponse,
} from "./protocol.js";
import { TerminalManager } from "./terminal.js";
import { MacVisualService } from "./visual.js";

export type LocalAgentRuntimeConfig = {
  gatewayUrl: URL;
  token: string;
  agentId: string;
  pollWaitMs: number;
  maxOutputBytes: number;
  maxFileBytes: number;
  maxTerminalBytes: number;
  maxSessions: number;
  maxCommandTimeoutMs: number;
  maxScreenshotBytes: number;
  maxScreenshotEdge: number;
};

function integerEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = Number(env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

export function loadLocalAgentConfig(env: NodeJS.ProcessEnv = process.env): LocalAgentRuntimeConfig {
  const rawGatewayUrl = env.LOCAL_AGENT_GATEWAY_URL?.trim();
  const token = env.LOCAL_AGENT_TOKEN?.trim() ?? "";
  if (!rawGatewayUrl) throw new Error("Set LOCAL_AGENT_GATEWAY_URL to the public MCP gateway base URL");
  if (!token) throw new Error("Set LOCAL_AGENT_TOKEN to the same high-entropy token configured on the gateway");

  return {
    gatewayUrl: new URL(rawGatewayUrl),
    token,
    agentId: env.LOCAL_AGENT_ID?.trim() || `${hostname()}-${randomUUID()}`,
    pollWaitMs: integerEnv(env, "LOCAL_AGENT_POLL_WAIT_MS", 25_000),
    maxOutputBytes: integerEnv(env, "LOCAL_AGENT_MAX_OUTPUT_BYTES", 500_000),
    maxFileBytes: integerEnv(env, "LOCAL_AGENT_MAX_FILE_BYTES", 1_000_000),
    maxTerminalBytes: integerEnv(env, "LOCAL_AGENT_MAX_TERMINAL_BYTES", 1_000_000),
    maxSessions: integerEnv(env, "LOCAL_AGENT_MAX_SESSIONS", 16),
    maxCommandTimeoutMs: integerEnv(env, "LOCAL_AGENT_MAX_COMMAND_TIMEOUT_MS", 120_000),
    maxScreenshotBytes: integerEnv(env, "LOCAL_AGENT_MAX_SCREENSHOT_BYTES", 1_500_000),
    maxScreenshotEdge: integerEnv(env, "LOCAL_AGENT_SCREENSHOT_MAX_EDGE", 1600),
  };
}

function endpoint(config: LocalAgentRuntimeConfig, path: string): URL {
  return new URL(path, new URL("/", config.gatewayUrl));
}

async function postJson(
  fetchImpl: typeof fetch,
  url: URL,
  token: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<Response> {
  return await fetchImpl(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    ...(signal === undefined ? {} : { signal }),
  });
}

export async function runAgentCycle(
  config: LocalAgentRuntimeConfig,
  services: LocalExecutionServices,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<boolean> {
  const poll = await postJson(
    fetchImpl,
    endpoint(config, "/local-agent/poll"),
    config.token,
    { agentId: config.agentId, waitMs: config.pollWaitMs },
    signal,
  );

  if (poll.status === 204) return false;
  if (!poll.ok) throw new Error(`Local-agent poll failed: HTTP ${poll.status} ${await poll.text()}`);

  const value: unknown = await poll.json();
  if (!isLocalRpcRequest(value)) throw new Error("Gateway returned a malformed local RPC request");
  const request: LocalRpcRequest = value;

  let response: LocalRpcResponse;
  try {
    response = toLocalRpcResponse(request.id, await dispatchLocalRequest(request.method, request.params, services));
  } catch (error) {
    response = toLocalRpcErrorResponse(request.id, error);
  }

  const responseUrl = endpoint(config, "/local-agent/respond");
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    let posted: Response | undefined;
    try {
      posted = await postJson(fetchImpl, responseUrl, config.token, { agentId: config.agentId, response }, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      lastError = error instanceof Error ? error : new Error(String(error));
    }
    if (posted) {
      if (posted.ok) return true;
      const error = new Error(`Local-agent response failed: HTTP ${posted.status} ${await posted.text()}`);
      if (posted.status < 500) throw error;
      lastError = error;
    }
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 200 * 2 ** (attempt - 1)));
  }
  throw lastError ?? new Error("Local-agent response delivery failed");
}

export async function runLocalAgent(
  config = loadLocalAgentConfig(),
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<void> {
  const terminal = new TerminalManager({
    maxBufferBytes: config.maxTerminalBytes,
    maxSessions: config.maxSessions,
  });
  const services: LocalExecutionServices = {
    terminal,
    maxOutputBytes: config.maxOutputBytes,
    maxFileBytes: config.maxFileBytes,
    maxCommandTimeoutMs: config.maxCommandTimeoutMs,
    visual: new MacVisualService(),
    maxScreenshotBytes: config.maxScreenshotBytes,
    maxScreenshotEdge: config.maxScreenshotEdge,
  };

  let backoffMs = 500;
  console.log(`Mac local agent ${config.agentId} connecting to ${config.gatewayUrl.origin}`);

  try {
    while (!signal?.aborted) {
      try {
        await runAgentCycle(config, services, fetchImpl, signal);
        backoffMs = 500;
      } catch (error) {
        if (signal?.aborted) break;
        console.error(`Local-agent cycle failed: ${error instanceof Error ? error.message : String(error)}`);
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        backoffMs = Math.min(backoffMs * 2, 15_000);
      }
    }
  } finally {
    terminal.closeAll();
  }
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  const controller = new AbortController();
  process.on("SIGINT", () => controller.abort());
  process.on("SIGTERM", () => controller.abort());
  void runLocalAgent(loadLocalAgentConfig(), fetch, controller.signal).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
