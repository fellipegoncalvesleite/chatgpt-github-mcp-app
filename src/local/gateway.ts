import { timingSafeEqual } from "node:crypto";
import type { AppConfig } from "../config.js";
import { AppError } from "../errors.js";
import {
  isLocalRpcResponse,
  makeLocalRpcRequest,
  type LocalRpcRequest,
} from "./protocol.js";

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type PollWaiter = {
  agentId: string;
  resolve: (request: LocalRpcRequest | null) => void;
  timer: NodeJS.Timeout;
};

export type LocalAgentStatus = {
  configured: boolean;
  connected: boolean;
  agentId: string | null;
  lastSeenAt: string | null;
  queuedRequests: number;
  pendingRequests: number;
};

export type LocalAgentGatewayConfig = Pick<
  AppConfig,
  "localAgentToken" | "localAgentRpcTimeoutMs" | "localAgentPollWaitMs"
>;

export class LocalAgentGateway {
  private readonly queue: LocalRpcRequest[] = [];
  private readonly pending = new Map<string, PendingRequest>();
  private readonly completedResponses = new Map<string, { agentId: string; expiresAt: number }>();
  private readonly pollWaiters: PollWaiter[] = [];
  private connectedAgentId: string | null = null;
  private lastSeenAtMs: number | null = null;

  constructor(private readonly config: LocalAgentGatewayConfig) {}

  isConfigured(): boolean {
    return this.config.localAgentToken.trim().length > 0;
  }

  assertToken(candidate: string): void {
    if (!this.isConfigured()) {
      throw new AppError("agent_not_configured", "LOCAL_AGENT_TOKEN is not configured on the gateway", 503);
    }
    const expected = Buffer.from(this.config.localAgentToken);
    const actual = Buffer.from(candidate);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw new AppError("agent_unauthorized", "Local agent authentication failed", 401);
    }
  }

  status(): LocalAgentStatus {
    const connected = this.isConnected();
    return {
      configured: this.isConfigured(),
      connected,
      agentId: connected ? this.connectedAgentId : null,
      lastSeenAt: this.lastSeenAtMs === null ? null : new Date(this.lastSeenAtMs).toISOString(),
      queuedRequests: this.queue.length,
      pendingRequests: this.pending.size,
    };
  }

  async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (!this.isConfigured()) {
      throw new AppError("agent_not_configured", "LOCAL_AGENT_TOKEN is not configured on the gateway", 503);
    }
    if (!this.isConnected()) {
      throw new AppError("agent_disconnected", "The Mac local agent is not currently connected", 503);
    }

    const request = makeLocalRpcRequest(method, params);
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.id);
        const queuedIndex = this.queue.findIndex((item) => item.id === request.id);
        if (queuedIndex >= 0) this.queue.splice(queuedIndex, 1);
        reject(new AppError("agent_timeout", `Local agent request timed out after ${this.config.localAgentRpcTimeoutMs} ms`, 504));
      }, this.config.localAgentRpcTimeoutMs);
      timer.unref?.();
      this.pending.set(request.id, { resolve, reject, timer });
    });

    const waiterIndex = this.pollWaiters.findIndex((waiter) => waiter.agentId === this.connectedAgentId);
    if (waiterIndex >= 0) {
      const [waiter] = this.pollWaiters.splice(waiterIndex, 1);
      if (waiter) {
        clearTimeout(waiter.timer);
        waiter.resolve(request);
      } else {
        this.queue.push(request);
      }
    } else {
      this.queue.push(request);
    }

    return result;
  }

  async poll(agentId: string, waitMs = this.config.localAgentPollWaitMs): Promise<LocalRpcRequest | null> {
    this.markSeen(agentId);

    const queued = this.queue.shift();
    if (queued) return queued;

    const boundedWaitMs = Math.max(0, Math.min(waitMs, this.config.localAgentPollWaitMs));
    if (boundedWaitMs === 0) return null;

    return await new Promise<LocalRpcRequest | null>((resolve) => {
      const waiter: PollWaiter = {
        agentId,
        resolve,
        timer: setTimeout(() => {
          const index = this.pollWaiters.indexOf(waiter);
          if (index >= 0) this.pollWaiters.splice(index, 1);
          this.markSeen(agentId);
          resolve(null);
        }, boundedWaitMs),
      };
      waiter.timer.unref?.();
      this.pollWaiters.push(waiter);
    });
  }

  respond(agentId: string, value: unknown): void {
    this.markSeen(agentId);
    if (!isLocalRpcResponse(value)) {
      throw new AppError("rpc_protocol_error", "Malformed local-agent response envelope", 400);
    }
    if (this.connectedAgentId !== agentId) {
      throw new AppError("agent_replaced", "This local-agent connection has been replaced", 409);
    }
    const now = Date.now();
    for (const [id, completed] of this.completedResponses) {
      if (completed.expiresAt <= now) this.completedResponses.delete(id);
    }
    const pending = this.pending.get(value.id);
    if (!pending) {
      const completed = this.completedResponses.get(value.id);
      if (completed?.agentId === agentId && completed.expiresAt > now) return;
      throw new AppError("unknown_rpc_request", `No pending local-agent request ${value.id}`, 404);
    }
    this.pending.delete(value.id);
    clearTimeout(pending.timer);
    this.completedResponses.set(value.id, { agentId, expiresAt: now + 60_000 });

    if (value.ok === true) {
      pending.resolve(value.result);
      return;
    }

    const rpcError = value.error;
    pending.reject(new AppError(
      rpcError.code,
      rpcError.message,
      500,
      rpcError.details,
    ));
  }

  close(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new AppError("agent_disconnected", "Local-agent gateway closed", 503));
    }
    this.pending.clear();
    this.completedResponses.clear();
    for (const waiter of this.pollWaiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.resolve(null);
    }
    this.queue.length = 0;
    this.connectedAgentId = null;
    this.lastSeenAtMs = null;
  }

  private markSeen(agentId: string): void {
    if (!agentId.trim()) {
      throw new AppError("invalid_agent_id", "agentId is required", 400);
    }
    if (this.connectedAgentId !== null && this.connectedAgentId !== agentId) {
      for (const waiter of this.pollWaiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.resolve(null);
      }
    }
    this.connectedAgentId = agentId;
    this.lastSeenAtMs = Date.now();
  }

  private isConnected(): boolean {
    if (!this.isConfigured() || this.connectedAgentId === null || this.lastSeenAtMs === null) return false;
    const freshnessWindow = Math.max(
      this.config.localAgentPollWaitMs * 3,
      this.config.localAgentRpcTimeoutMs + this.config.localAgentPollWaitMs,
      60_000,
    );
    return Date.now() - this.lastSeenAtMs <= freshnessWindow;
  }
}

export type LocalToolGateway = Pick<LocalAgentGateway, "request" | "status">;
