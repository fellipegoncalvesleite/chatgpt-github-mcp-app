import { arch, homedir, hostname, platform, uptime } from "node:os";
import {
  copyLocalPath,
  deleteLocalPath,
  listLocalDirectory,
  moveLocalPath,
  readLocalTextFile,
  searchLocalFiles,
  writeLocalTextFile,
} from "./filesystem.js";
import { getLocalCapabilities } from "./capabilities.js";
import { searchCode } from "./code-search.js";
import { reviewGit } from "./git-review.js";
import { killLocalProcess, listLocalProcesses } from "./processes.js";
import { getProjectContext } from "./project-context.js";
import { LocalExecutionError } from "./protocol.js";
import { runShell } from "./shell.js";
import { TerminalManager } from "./terminal.js";
import type { LocalVisualService } from "./visual.js";

export type LocalExecutionServices = {
  terminal: TerminalManager;
  maxOutputBytes: number;
  maxFileBytes: number;
  maxCommandTimeoutMs: number;
  visual?: LocalVisualService;
  maxScreenshotBytes?: number;
  maxScreenshotEdge?: number;
};

function objectParams(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new LocalExecutionError("invalid_params", "Parameters must be an object");
  }
  return value as Record<string, unknown>;
}

function stringParam(params: Record<string, unknown>, key: string, required = true): string | undefined {
  const value = params[key];
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || (required && !value.trim())) {
    throw new LocalExecutionError("invalid_params", `${key} must be a${required ? " non-empty" : ""} string`);
  }
  return value;
}

function booleanParam(params: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = params[key];
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new LocalExecutionError("invalid_params", `${key} must be a boolean`);
  return value;
}

function numberParam(
  params: Record<string, unknown>,
  key: string,
  options: { fallback?: number; min?: number; max?: number } = {},
): number | undefined {
  const value = params[key];
  if (value === undefined) return options.fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new LocalExecutionError("invalid_params", `${key} must be a finite number`);
  }
  const integer = Math.floor(value);
  if (options.min !== undefined && integer < options.min) throw new LocalExecutionError("invalid_params", `${key} must be >= ${options.min}`);
  if (options.max !== undefined && integer > options.max) throw new LocalExecutionError("invalid_params", `${key} must be <= ${options.max}`);
  return integer;
}

function stringArrayParam(params: Record<string, unknown>, key: string): string[] | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new LocalExecutionError("invalid_params", `${key} must be an array of non-empty strings`);
  }
  return value as string[];
}

function envParam(params: Record<string, unknown>): Record<string, string> | undefined {
  const value = params.env;
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new LocalExecutionError("invalid_params", "env must be an object of string values");
  }
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") throw new LocalExecutionError("invalid_params", `env.${key} must be a string`);
    result[key] = item;
  }
  return result;
}

function signalParam(params: Record<string, unknown>, fallback: NodeJS.Signals = "SIGTERM"): NodeJS.Signals {
  const value = params.signal;
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^SIG[A-Z0-9]+$/.test(value)) {
    throw new LocalExecutionError("invalid_params", "signal must look like SIGTERM");
  }
  return value as NodeJS.Signals;
}

export async function dispatchLocalRequest(
  method: string,
  rawParams: Record<string, unknown>,
  services: LocalExecutionServices,
): Promise<unknown> {
  const params = objectParams(rawParams);

  switch (method) {
    case "system.capabilities":
      return getLocalCapabilities();

    case "system.info":
      return {
        hostname: hostname(),
        platform: platform(),
        arch: arch(),
        homeDirectory: homedir(),
        shell: process.env.SHELL ?? (process.platform === "darwin" ? "/bin/zsh" : "/bin/sh"),
        cwd: process.cwd(),
        nodeVersion: process.version,
        processId: process.pid,
        uptimeSeconds: uptime(),
      };

    case "fs.list":
      return await listLocalDirectory(stringParam(params, "path")!);
    case "fs.read":
      return await readLocalTextFile(stringParam(params, "path")!, services.maxFileBytes);
    case "fs.write":
      return await writeLocalTextFile(
        stringParam(params, "path")!,
        stringParam(params, "content", false) ?? "",
        {
          createParents: booleanParam(params, "createParents", false),
          maxBytes: services.maxFileBytes,
        },
      );
    case "fs.move":
      return await moveLocalPath(
        stringParam(params, "source")!,
        stringParam(params, "destination")!,
        booleanParam(params, "overwrite", false),
      );
    case "fs.copy":
      return await copyLocalPath(
        stringParam(params, "source")!,
        stringParam(params, "destination")!,
        booleanParam(params, "recursive", false),
        booleanParam(params, "overwrite", false),
      );
    case "fs.delete":
      return await deleteLocalPath(
        stringParam(params, "path")!,
        booleanParam(params, "recursive", false),
        booleanParam(params, "force", false),
      );
    case "fs.search":
      return await searchLocalFiles(
        stringParam(params, "root")!,
        stringParam(params, "query")!,
        { maxResults: numberParam(params, "maxResults", { fallback: 50, min: 1, max: 500 }) ?? 50 },
      );

    case "visual.uiContext": {
      if (!services.visual) throw new LocalExecutionError("visual_unavailable", "Visual inspection is not configured on this local agent");
      return await services.visual.getUiContext();
    }

    case "visual.captureScreen": {
      if (!services.visual) throw new LocalExecutionError("visual_unavailable", "Visual inspection is not configured on this local agent");
      const rawDisplay = params.display;
      const display = rawDisplay === undefined || rawDisplay === "main"
        ? "main"
        : numberParam(params, "display", { min: 1, max: 32 })!;
      const serviceMaxEdge = services.maxScreenshotEdge ?? 1600;
      const requestedMaxEdge = numberParam(params, "maxEdge", { fallback: serviceMaxEdge, min: 256, max: 16_384 }) ?? serviceMaxEdge;
      return await services.visual.captureScreen({
        display,
        includeCursor: booleanParam(params, "includeCursor", false),
        maxEdge: Math.min(requestedMaxEdge, serviceMaxEdge),
        maxBytes: services.maxScreenshotBytes ?? 1_500_000,
      });
    }

    case "development.projectContext":
      return await getProjectContext(stringParam(params, "workingDirectory")!);

    case "development.codeSearch":
      return await searchCode({
        root: stringParam(params, "root")!,
        query: stringParam(params, "query")!,
        globs: stringArrayParam(params, "globs") ?? [],
        maxResults: numberParam(params, "maxResults", { fallback: 50, min: 1, max: 500 }) ?? 50,
        contextLines: numberParam(params, "contextLines", { fallback: 1, min: 0, max: 5 }) ?? 1,
        regex: booleanParam(params, "regex", false),
        caseSensitive: booleanParam(params, "caseSensitive", true),
      });

    case "development.gitReview":
      return await reviewGit({
        workingDirectory: stringParam(params, "workingDirectory")!,
        includePatch: booleanParam(params, "includePatch", false),
        maxPatchBytes: numberParam(params, "maxPatchBytes", { fallback: 200_000, min: 1_000, max: 2_000_000 }) ?? 200_000,
      });

    case "shell.run": {
      const timeoutMs = Math.min(
        numberParam(params, "timeoutMs", { fallback: services.maxCommandTimeoutMs, min: 100 }) ?? services.maxCommandTimeoutMs,
        services.maxCommandTimeoutMs,
      );
      const cwd = stringParam(params, "cwd", false);
      const env = envParam(params);
      return await runShell(stringParam(params, "command")!, {
        ...(cwd === undefined ? {} : { cwd }),
        ...(env === undefined ? {} : { env }),
        timeoutMs,
        maxOutputBytes: services.maxOutputBytes,
      });
    }

    case "terminal.start": {
      const command = stringParam(params, "command", false);
      const cwd = stringParam(params, "cwd", false);
      const env = envParam(params);
      return services.terminal.start({
        ...(command === undefined ? {} : { command }),
        ...(cwd === undefined ? {} : { cwd }),
        cols: numberParam(params, "cols", { fallback: 120, min: 20, max: 500 }) ?? 120,
        rows: numberParam(params, "rows", { fallback: 40, min: 5, max: 300 }) ?? 40,
        ...(env === undefined ? {} : { env }),
      });
    }
    case "terminal.read":
      return services.terminal.read(
        stringParam(params, "sessionId")!,
        numberParam(params, "cursor", { fallback: 0, min: 0 }) ?? 0,
      );
    case "terminal.send":
      return services.terminal.send(
        stringParam(params, "sessionId")!,
        stringParam(params, "input", false) ?? "",
      );
    case "terminal.resize":
      return services.terminal.resize(
        stringParam(params, "sessionId")!,
        numberParam(params, "cols", { min: 20, max: 500 })!,
        numberParam(params, "rows", { min: 5, max: 300 })!,
      );
    case "terminal.stop":
      return services.terminal.stop(stringParam(params, "sessionId")!, signalParam(params));

    case "process.list":
      return await listLocalProcesses(
        stringParam(params, "filter", false),
        numberParam(params, "limit", { fallback: 500, min: 1, max: 2_000 }) ?? 500,
      );
    case "process.kill":
      return killLocalProcess(numberParam(params, "pid", { min: 1 })!, signalParam(params));

    default:
      throw new LocalExecutionError("unknown_method", `Unknown local-agent method: ${method}`);
  }
}
