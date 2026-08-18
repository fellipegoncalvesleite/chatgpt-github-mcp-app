import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { z } from "zod/v4";
import type { AuditLogger } from "../audit.js";
import { AppError, toErrorMessage } from "../errors.js";
import type { LocalToolGateway } from "./gateway.js";

type ToolExtra = { authInfo?: AuthInfo };

function requireLocalScope(extra: ToolExtra, scope: "local:read" | "local:write"): void {
  const scopes = extra.authInfo?.scopes ?? [];
  if (!scopes.includes(scope)) {
    throw new AppError("insufficient_scope", `This tool requires OAuth scope ${scope}`, 403, { requiredScope: scope });
  }
}

function actorFrom(extra: ToolExtra): { actor?: string; clientId?: string } {
  const subject = extra.authInfo?.extra?.subject;
  return {
    ...(typeof subject === "string" ? { actor: subject } : {}),
    ...(extra.authInfo?.clientId ? { clientId: extra.authInfo.clientId } : {}),
  };
}

function successResult(value: unknown) {
  const objectValue = typeof value === "object" && value !== null ? value as Record<string, unknown> : { value };
  const serialized = JSON.stringify(value, null, 2);
  return {
    content: [{
      type: "text" as const,
      text: serialized.length <= 20_000
        ? serialized
        : `Large local result returned in structuredContent (${serialized.length} characters).`,
    }],
    structuredContent: objectValue,
  };
}

function errorResult(error: unknown) {
  const appError = error instanceof AppError ? error : new AppError("internal_error", toErrorMessage(error), 500);
  return {
    isError: true,
    content: [{ type: "text" as const, text: `${appError.code}: ${appError.message}` }],
    structuredContent: {
      error: appError.code,
      message: appError.message,
      ...(appError.details === undefined ? {} : { details: appError.details }),
    },
  };
}

async function localTool(
  audit: AuditLogger,
  tool: string,
  extra: ToolExtra,
  details: Record<string, unknown>,
  action: () => Promise<unknown>,
) {
  try {
    const result = await action();
    await audit.write({
      ...actorFrom(extra),
      tool,
      outcome: "success",
      details,
    });
    return successResult(result);
  } catch (error) {
    const denied = error instanceof AppError && error.status >= 400 && error.status < 500;
    await audit.write({
      ...actorFrom(extra),
      tool,
      outcome: denied ? "denied" : "error",
      details: {
        ...details,
        code: error instanceof AppError ? error.code : "internal_error",
        message: toErrorMessage(error),
      },
    });
    return errorResult(error);
  }
}

function screenCaptureResult(value: unknown): {
  imageBase64: string;
  mimeType: "image/png";
  display: "main" | number;
  width: number;
  height: number;
  byteLength: number;
} {
  if (typeof value !== "object" || value === null) {
    throw new AppError("invalid_local_result", "Local screenshot response is not an object", 502);
  }
  const record = value as Record<string, unknown>;
  const display = record.display;
  if (
    typeof record.imageBase64 !== "string"
    || record.mimeType !== "image/png"
    || (display !== "main" && typeof display !== "number")
    || typeof record.width !== "number"
    || typeof record.height !== "number"
    || typeof record.byteLength !== "number"
  ) {
    throw new AppError("invalid_local_result", "Local screenshot response has an invalid shape", 502);
  }
  return {
    imageBase64: record.imageBase64,
    mimeType: "image/png",
    display,
    width: record.width,
    height: record.height,
    byteLength: record.byteLength,
  };
}

async function localImageTool(
  audit: AuditLogger,
  tool: string,
  extra: ToolExtra,
  details: Record<string, unknown>,
  action: () => Promise<unknown>,
) {
  try {
    const result = screenCaptureResult(await action());
    await audit.write({
      ...actorFrom(extra),
      tool,
      outcome: "success",
      details,
    });
    const { imageBase64, ...metadata } = result;
    return {
      content: [{ type: "image" as const, data: imageBase64, mimeType: result.mimeType }],
      structuredContent: metadata,
    };
  } catch (error) {
    const denied = error instanceof AppError && error.status >= 400 && error.status < 500;
    await audit.write({
      ...actorFrom(extra),
      tool,
      outcome: denied ? "denied" : "error",
      details: {
        ...details,
        code: error instanceof AppError ? error.code : "internal_error",
        message: toErrorMessage(error),
      },
    });
    return errorResult(error);
  }
}

const pathSchema = z.string().min(1).max(32_768);
const envSchema = z.record(z.string(), z.string());

export function registerLocalTools(
  server: McpServer,
  dependencies: {
    gateway: LocalToolGateway;
    audit: AuditLogger;
    bridgeCapabilities?: { githubMergeEnabled: boolean; gmailConfigured: boolean };
  },
): void {
  const { gateway, audit } = dependencies;

  server.registerTool(
    "local_get_capabilities",
    {
      title: "Get bridge capabilities",
      description: "Report the caller's effective GitHub, local Mac, visual, and Gmail capabilities. Screen Recording permission remains unknown until a capture is attempted.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (_input, extra) => localTool(audit, "local_get_capabilities", extra, {}, async () => {
      requireLocalScope(extra, "local:read");
      const raw = await gateway.request("system.capabilities", {});
      if (typeof raw !== "object" || raw === null) {
        throw new AppError("invalid_local_result", "Local capability response is not an object", 502);
      }
      const local = raw as { local?: unknown; vision?: unknown; platform?: unknown };
      const scopes = extra.authInfo?.scopes ?? [];
      const bridge = dependencies.bridgeCapabilities ?? { githubMergeEnabled: false, gmailConfigured: false };
      return {
        GitHub: {
          read: scopes.includes("github:read"),
          write: scopes.includes("github:write"),
          merge: bridge.githubMergeEnabled && scopes.includes("github:merge"),
        },
        Local: local.local ?? {},
        Vision: local.vision ?? {},
        Gmail: {
          read: bridge.gmailConfigured && scopes.includes("gmail:read"),
          send: bridge.gmailConfigured && scopes.includes("gmail:write"),
        },
        platform: local.platform ?? null,
      };
    }),
  );

  server.registerTool(
    "local_get_info",
    {
      title: "Get local Mac agent information",
      description: "Report whether the Mac local agent is connected and, when online, return basic machine/runtime information.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (_input, extra) => localTool(audit, "local_get_info", extra, {}, async () => {
      requireLocalScope(extra, "local:read");
      const status = gateway.status();
      if (!status.connected) return { gateway: status, machine: null };
      return { gateway: status, machine: await gateway.request("system.info", {}) };
    }),
  );

  server.registerTool(
    "local_get_ui_context",
    {
      title: "Get frontmost Mac UI context",
      description: "Read the frontmost application, bundle identifier, and best-effort window title without activating, focusing, clicking, or typing in any application.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (_input, extra) => localTool(audit, "local_get_ui_context", extra, {}, async () => {
      requireLocalScope(extra, "local:read");
      return await gateway.request("visual.uiContext", {});
    }),
  );

  server.registerTool(
    "local_capture_screen",
    {
      title: "Capture one Mac screenshot",
      description: "Capture one bounded screenshot for task-driven visual inspection. This is read-only and does not click, type, focus applications, or continuously monitor the screen.",
      inputSchema: z.object({
        display: z.union([z.literal("main"), z.number().int().min(1).max(32)]).default("main"),
        includeCursor: z.boolean().default(false),
        maxEdge: z.number().int().min(256).max(16_384).default(1600),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (input, extra) => localImageTool(audit, "local_capture_screen", extra, { display: input.display }, async () => {
      requireLocalScope(extra, "local:read");
      return await gateway.request("visual.captureScreen", input);
    }),
  );

  server.registerTool(
    "local_get_project_context",
    {
      title: "Get local project context",
      description: "Summarize the current Git repository, branch/dirty state, detected project metadata, discoverable commands, and applicable AGENTS instruction files in one read-only call.",
      inputSchema: z.object({ workingDirectory: pathSchema }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ workingDirectory }, extra) => localTool(audit, "local_get_project_context", extra, { workingDirectory }, async () => {
      requireLocalScope(extra, "local:read");
      return await gateway.request("development.projectContext", { workingDirectory });
    }),
  );

  server.registerTool(
    "local_code_search",
    {
      title: "Search local source code",
      description: "Search repository text quickly with path/line/context results. Prefers ripgrep when available and otherwise uses a Git-aware fallback that respects ignored files.",
      inputSchema: z.object({
        root: pathSchema,
        query: z.string().min(1).max(10_000),
        globs: z.array(z.string().min(1).max(1_000)).max(50).optional(),
        maxResults: z.number().int().min(1).max(500).default(50),
        contextLines: z.number().int().min(0).max(5).default(1),
        regex: z.boolean().default(false),
        caseSensitive: z.boolean().default(true),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input, extra) => localTool(audit, "local_code_search", extra, { root: input.root, query: input.query }, async () => {
      requireLocalScope(extra, "local:read");
      return await gateway.request("development.codeSearch", input);
    }),
  );

  server.registerTool(
    "local_git_review",
    {
      title: "Review local Git state",
      description: "Return structured branch, upstream, staged/unstaged/untracked/conflict state and diff stats, with an optional bounded patch.",
      inputSchema: z.object({
        workingDirectory: pathSchema,
        includePatch: z.boolean().default(false),
        maxPatchBytes: z.number().int().min(1_000).max(2_000_000).default(200_000),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input, extra) => localTool(audit, "local_git_review", extra, { workingDirectory: input.workingDirectory }, async () => {
      requireLocalScope(extra, "local:read");
      return await gateway.request("development.gitReview", input);
    }),
  );

  server.registerTool(
    "local_list_directory",
    {
      title: "List local directory",
      description: "List files and directories at any path accessible to the Mac user account.",
      inputSchema: z.object({ path: pathSchema }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ path }, extra) => localTool(audit, "local_list_directory", extra, { paths: [path] }, async () => {
      requireLocalScope(extra, "local:read");
      return await gateway.request("fs.list", { path });
    }),
  );

  server.registerTool(
    "local_read_file",
    {
      title: "Read local text file",
      description: "Read a UTF-8 text file at any path accessible to the Mac user account.",
      inputSchema: z.object({ path: pathSchema }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ path }, extra) => localTool(audit, "local_read_file", extra, { paths: [path] }, async () => {
      requireLocalScope(extra, "local:read");
      return await gateway.request("fs.read", { path });
    }),
  );

  server.registerTool(
    "local_write_file",
    {
      title: "Write local text file",
      description: "Create or replace a UTF-8 file on the Mac. This can write anywhere the Mac user account has permission.",
      inputSchema: z.object({
        path: pathSchema,
        content: z.string(),
        createParents: z.boolean().default(false),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ path, content, createParents }, extra) => localTool(audit, "local_write_file", extra, { paths: [path] }, async () => {
      requireLocalScope(extra, "local:write");
      return await gateway.request("fs.write", { path, content, createParents });
    }),
  );

  server.registerTool(
    "local_move",
    {
      title: "Move local path",
      description: "Move or rename a file/directory on the Mac.",
      inputSchema: z.object({ source: pathSchema, destination: pathSchema, overwrite: z.boolean().default(false) }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ source, destination, overwrite }, extra) => localTool(audit, "local_move", extra, { paths: [source, destination] }, async () => {
      requireLocalScope(extra, "local:write");
      return await gateway.request("fs.move", { source, destination, overwrite });
    }),
  );

  server.registerTool(
    "local_copy",
    {
      title: "Copy local path",
      description: "Copy a file or directory on the Mac.",
      inputSchema: z.object({
        source: pathSchema,
        destination: pathSchema,
        recursive: z.boolean().default(false),
        overwrite: z.boolean().default(false),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ source, destination, recursive, overwrite }, extra) => localTool(audit, "local_copy", extra, { paths: [source, destination] }, async () => {
      requireLocalScope(extra, "local:write");
      return await gateway.request("fs.copy", { source, destination, recursive, overwrite });
    }),
  );

  server.registerTool(
    "local_delete",
    {
      title: "Delete local path",
      description: "Delete a file or directory on the Mac. Recursive deletion is available and this operation is destructive.",
      inputSchema: z.object({
        path: pathSchema,
        recursive: z.boolean().default(false),
        force: z.boolean().default(false),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ path, recursive, force }, extra) => localTool(audit, "local_delete", extra, { paths: [path] }, async () => {
      requireLocalScope(extra, "local:write");
      return await gateway.request("fs.delete", { path, recursive, force });
    }),
  );

  server.registerTool(
    "local_search_files",
    {
      title: "Search local files",
      description: "Search path names and bounded text contents under any local root accessible to the Mac user.",
      inputSchema: z.object({
        root: pathSchema,
        query: z.string().min(1),
        maxResults: z.number().int().min(1).max(500).default(50),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ root, query, maxResults }, extra) => localTool(audit, "local_search_files", extra, { paths: [root], query }, async () => {
      requireLocalScope(extra, "local:read");
      return await gateway.request("fs.search", { root, query, maxResults });
    }),
  );

  server.registerTool(
    "local_run",
    {
      title: "Run command on local Mac",
      description: "Run an arbitrary shell command on the Mac with the user's normal permissions. Commands may modify files, install software, invoke sudo, run tests, Git, debuggers, or other developer tools.",
      inputSchema: z.object({
        command: z.string().min(1).max(100_000),
        cwd: pathSchema.optional(),
        env: envSchema.optional(),
        timeoutMs: z.number().int().min(100).max(600_000).optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ command, cwd, env, timeoutMs }, extra) => localTool(audit, "local_run", extra, {
      ...(cwd === undefined ? {} : { cwd }),
      commandLength: command.length,
    }, async () => {
      requireLocalScope(extra, "local:write");
      return await gateway.request("shell.run", {
        command,
        ...(cwd === undefined ? {} : { cwd }),
        ...(env === undefined ? {} : { env }),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      });
    }),
  );

  server.registerTool(
    "local_terminal_start",
    {
      title: "Start persistent local terminal",
      description: "Start a persistent interactive terminal session on the Mac for debuggers, REPLs, dev servers, or commands that wait for input.",
      inputSchema: z.object({
        command: z.string().min(1).max(100_000).optional(),
        cwd: pathSchema.optional(),
        cols: z.number().int().min(20).max(500).default(120),
        rows: z.number().int().min(5).max(300).default(40),
        env: envSchema.optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (input, extra) => localTool(audit, "local_terminal_start", extra, {
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    }, async () => {
      requireLocalScope(extra, "local:write");
      return await gateway.request("terminal.start", input);
    }),
  );

  server.registerTool(
    "local_terminal_read",
    {
      title: "Read persistent local terminal",
      description: "Read terminal output since a previous cursor.",
      inputSchema: z.object({ sessionId: z.string().min(1), cursor: z.number().int().min(0).default(0) }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ sessionId, cursor }, extra) => localTool(audit, "local_terminal_read", extra, { sessionId }, async () => {
      requireLocalScope(extra, "local:read");
      return await gateway.request("terminal.read", { sessionId, cursor });
    }),
  );

  server.registerTool(
    "local_terminal_send",
    {
      title: "Send input to persistent local terminal",
      description: "Write text/input to an existing terminal session.",
      inputSchema: z.object({ sessionId: z.string().min(1), input: z.string().max(1_000_000) }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ sessionId, input }, extra) => localTool(audit, "local_terminal_send", extra, { sessionId, inputLength: input.length }, async () => {
      requireLocalScope(extra, "local:write");
      return await gateway.request("terminal.send", { sessionId, input });
    }),
  );

  server.registerTool(
    "local_terminal_resize",
    {
      title: "Resize persistent local terminal",
      description: "Request a terminal resize. The dependency-free macOS script-based PTY reports best-effort resize support.",
      inputSchema: z.object({
        sessionId: z.string().min(1),
        cols: z.number().int().min(20).max(500),
        rows: z.number().int().min(5).max(300),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input, extra) => localTool(audit, "local_terminal_resize", extra, { sessionId: input.sessionId }, async () => {
      requireLocalScope(extra, "local:write");
      return await gateway.request("terminal.resize", input);
    }),
  );

  server.registerTool(
    "local_terminal_stop",
    {
      title: "Stop persistent local terminal",
      description: "Terminate a persistent terminal session and its process group.",
      inputSchema: z.object({ sessionId: z.string().min(1), signal: z.string().regex(/^SIG[A-Z0-9]+$/).default("SIGTERM") }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (input, extra) => localTool(audit, "local_terminal_stop", extra, { sessionId: input.sessionId }, async () => {
      requireLocalScope(extra, "local:write");
      return await gateway.request("terminal.stop", input);
    }),
  );

  server.registerTool(
    "local_process_list",
    {
      title: "List local processes",
      description: "List a bounded set of processes visible to the Mac user account.",
      inputSchema: z.object({ filter: z.string().optional(), limit: z.number().int().min(1).max(2_000).default(500) }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input, extra) => localTool(audit, "local_process_list", extra, { filter: input.filter ?? null }, async () => {
      requireLocalScope(extra, "local:read");
      return await gateway.request("process.list", input);
    }),
  );

  server.registerTool(
    "local_process_kill",
    {
      title: "Signal local process",
      description: "Send a signal to a local process the Mac user account is permitted to signal.",
      inputSchema: z.object({
        pid: z.number().int().positive(),
        signal: z.string().regex(/^SIG[A-Z0-9]+$/).default("SIGTERM"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (input, extra) => localTool(audit, "local_process_kill", extra, { pid: input.pid, signal: input.signal }, async () => {
      requireLocalScope(extra, "local:write");
      return await gateway.request("process.kill", input);
    }),
  );
}
