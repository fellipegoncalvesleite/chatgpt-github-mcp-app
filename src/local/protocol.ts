import { randomUUID } from "node:crypto";

export type LocalRpcRequest = {
  type: "request";
  id: string;
  method: string;
  params: Record<string, unknown>;
  createdAt: number;
};

export type LocalRpcError = {
  code: string;
  message: string;
  details?: Record<string, unknown>;
};

export type LocalRpcResponse =
  | {
      type: "response";
      id: string;
      ok: true;
      result: unknown;
    }
  | {
      type: "response";
      id: string;
      ok: false;
      error: LocalRpcError;
    };

export class LocalExecutionError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "LocalExecutionError";
    this.code = code;
    this.details = details;
  }
}

export function makeLocalRpcRequest(method: string, params: Record<string, unknown>): LocalRpcRequest {
  return {
    type: "request",
    id: randomUUID(),
    method,
    params,
    createdAt: Date.now(),
  };
}

export function toLocalRpcResponse(id: string, result: unknown): LocalRpcResponse {
  return { type: "response", id, ok: true, result: result ?? null };
}

export function toLocalRpcErrorResponse(id: string, error: unknown): LocalRpcResponse {
  const payload = toLocalErrorPayload(error);
  return { type: "response", id, ok: false, error: payload };
}

export function toLocalErrorPayload(error: unknown): LocalRpcError {
  if (error instanceof LocalExecutionError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    };
  }
  if (error instanceof Error) {
    const nativeCode = (error as NodeJS.ErrnoException).code;
    return {
      code: typeof nativeCode === "string" ? nativeCode.toLowerCase() : "local_execution_error",
      message: error.message,
    };
  }
  return {
    code: "local_execution_error",
    message: String(error),
  };
}

export function isLocalRpcRequest(value: unknown): value is LocalRpcRequest {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return record.type === "request"
    && typeof record.id === "string"
    && typeof record.method === "string"
    && typeof record.createdAt === "number"
    && typeof record.params === "object"
    && record.params !== null
    && !Array.isArray(record.params);
}

export function isLocalRpcResponse(value: unknown): value is LocalRpcResponse {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.type !== "response" || typeof record.id !== "string" || typeof record.ok !== "boolean") return false;
  if (record.ok) return "result" in record;
  if (typeof record.error !== "object" || record.error === null) return false;
  const error = record.error as Record<string, unknown>;
  return typeof error.code === "string" && typeof error.message === "string";
}
