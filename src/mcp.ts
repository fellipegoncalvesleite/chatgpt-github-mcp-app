import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { z } from "zod/v4";
import type { AuditLogger } from "./audit.js";
import type { AppConfig } from "./config.js";
import { AppError, toErrorMessage } from "./errors.js";
import type { GitHubService } from "./github/service.js";
import { registerGmailTools, type GmailToolService } from "./gmail/mcp-tools.js";
import type { LocalToolGateway } from "./local/gateway.js";
import { registerLocalTools } from "./local/mcp-tools.js";
import { DEVELOPMENT_INSTRUCTIONS, developmentWorkflowText } from "./workflows/development.js";

export type GitHubToolService = Pick<
  GitHubService,
  | "listRepositories"
  | "getRepository"
  | "listTree"
  | "readFile"
  | "listPullRequests"
  | "getPullRequest"
  | "getCheckStatus"
  | "listWorkflowRuns"
  | "getWorkflowRun"
  | "createChange"
  | "commentPullRequest"
  | "mergePullRequest"
  | "deleteBranch"
>;

type ToolExtra = { authInfo?: AuthInfo };

type ToolAuditContext = {
  repository?: string;
  branch?: string;
  paths?: string[];
};

const repositorySchema = z
  .string()
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "Use owner/repository format")
  .describe("GitHub repository in owner/repository format");

const branchSchema = z.string().min(1).max(200).describe("Git branch name");
const pathSchema = z.string().min(1).max(1024).describe("Repository-relative file path");

const upsertChangeSchema = z.object({
  path: pathSchema,
  operation: z.literal("upsert"),
  content: z.string().describe("Complete UTF-8 text content that should exist at this path after the commit"),
});

const deleteChangeSchema = z.object({
  path: pathSchema,
  operation: z.literal("delete"),
});

const fileChangeSchema = z.discriminatedUnion("operation", [upsertChangeSchema, deleteChangeSchema]);

function requireScope(extra: ToolExtra, scope: "github:read" | "github:write" | "github:merge"): void {
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

function successResult(value: unknown, summary?: string) {
  const objectValue = typeof value === "object" && value !== null ? value as Record<string, unknown> : { value };
  return {
    content: [{ type: "text" as const, text: summary ?? JSON.stringify(value, null, 2) }],
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

async function auditedTool<T>(
  audit: AuditLogger,
  tool: string,
  extra: ToolExtra,
  context: ToolAuditContext,
  action: () => Promise<T>,
  text?: (result: T) => string,
) {
  try {
    const result = await action();
    await audit.write({
      ...actorFrom(extra),
      tool,
      ...context,
      outcome: "success",
    });
    return successResult(result, text?.(result));
  } catch (error) {
    const denied = error instanceof AppError && error.status >= 400 && error.status < 500;
    await audit.write({
      ...actorFrom(extra),
      tool,
      ...context,
      outcome: denied ? "denied" : "error",
      details: {
        code: error instanceof AppError ? error.code : "internal_error",
        message: toErrorMessage(error),
      },
    });
    return errorResult(error);
  }
}

export function createGitHubMcpServer(dependencies: {
  config: AppConfig;
  github: GitHubToolService;
  audit: AuditLogger;
  localGateway?: LocalToolGateway;
  gmail?: GmailToolService;
}): McpServer {
  const { config, github, audit, localGateway, gmail } = dependencies;
  const server = new McpServer(
    {
      name: "chatgpt-development-bridge",
      version: "0.2.0",
    },
    {
      capabilities: { logging: {} },
      instructions: DEVELOPMENT_INSTRUCTIONS.join(" "),
    },
  );

  server.registerTool(
    "github_list_repositories",
    {
      title: "List allowed GitHub repositories",
      description: "List repositories the self-hosted GitHub App is installed on and this service allows ChatGPT to access.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (_input, extra) => auditedTool(audit, "github_list_repositories", extra, {}, async () => {
      requireScope(extra, "github:read");
      return { repositories: await github.listRepositories() };
    }),
  );

  server.registerTool(
    "github_get_repository",
    {
      title: "Get GitHub repository",
      description: "Get metadata for one allowed repository, including its default branch and GitHub URL.",
      inputSchema: z.object({ repository: repositorySchema }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ repository }, extra) => auditedTool(audit, "github_get_repository", extra, { repository }, async () => {
      requireScope(extra, "github:read");
      return await github.getRepository(repository);
    }),
  );

  server.registerTool(
    "github_list_tree",
    {
      title: "List repository tree",
      description: "List files and directories at a branch, tag, or commit. Use this to understand a project before reading individual files.",
      inputSchema: z.object({
        repository: repositorySchema,
        ref: z.string().min(1).max(200).optional().describe("Branch, tag, or commit SHA; defaults to the repository default branch"),
        pathPrefix: z.string().min(1).max(1024).optional().describe("Optional repository-relative path prefix"),
        limit: z.number().int().min(1).max(config.maxTreeEntries).optional(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ repository, ref, pathPrefix, limit }, extra) => auditedTool(audit, "github_list_tree", extra, { repository }, async () => {
      requireScope(extra, "github:read");
      return await github.listTree(repository, ref, pathPrefix, limit);
    }),
  );

  server.registerTool(
    "github_read_file",
    {
      title: "Read repository text file",
      description: "Read one UTF-8 text file from an allowed repository. Protected secret-like paths and oversized files are blocked.",
      inputSchema: z.object({
        repository: repositorySchema,
        path: pathSchema,
        ref: z.string().min(1).max(200).optional().describe("Branch, tag, or commit SHA; defaults to the default branch"),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ repository, path, ref }, extra) => auditedTool(
      audit,
      "github_read_file",
      extra,
      { repository, paths: [path] },
      async () => {
        requireScope(extra, "github:read");
        return await github.readFile(repository, path, ref);
      },
      (result) => [
        `Repository: ${result.repository}`,
        `Path: ${result.path}`,
        `Ref: ${result.ref}`,
        `SHA: ${result.sha}`,
        "",
        result.content,
      ].join("\n"),
    ),
  );

  server.registerTool(
    "github_list_pull_requests",
    {
      title: "List pull requests",
      description: "List pull requests for an allowed repository.",
      inputSchema: z.object({
        repository: repositorySchema,
        state: z.enum(["open", "closed", "all"]).default("open"),
        limit: z.number().int().min(1).max(100).default(20),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ repository, state, limit }, extra) => auditedTool(audit, "github_list_pull_requests", extra, { repository }, async () => {
      requireScope(extra, "github:read");
      return { pullRequests: await github.listPullRequests(repository, state, limit) };
    }),
  );

  server.registerTool(
    "github_get_pull_request",
    {
      title: "Get pull request",
      description: "Get a Pull Request and its changed-file summary.",
      inputSchema: z.object({
        repository: repositorySchema,
        pullNumber: z.number().int().positive(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ repository, pullNumber }, extra) => auditedTool(audit, "github_get_pull_request", extra, { repository }, async () => {
      requireScope(extra, "github:read");
      return await github.getPullRequest(repository, pullNumber);
    }),
  );

  server.registerTool(
    "github_get_check_status",
    {
      title: "Get GitHub check status",
      description: "Read Check Runs and combined commit status for a branch, tag, or commit ref. This does not trigger, rerun, cancel, or modify CI.",
      inputSchema: z.object({
        repository: repositorySchema,
        ref: z.string().min(1).max(200),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ repository, ref }, extra) => auditedTool(audit, "github_get_check_status", extra, { repository }, async () => {
      requireScope(extra, "github:read");
      return await github.getCheckStatus(repository, ref);
    }),
  );

  server.registerTool(
    "github_list_workflow_runs",
    {
      title: "List GitHub Actions workflow runs",
      description: "List recent GitHub Actions runs for an allowed repository, optionally filtered by branch, event, or status. Read-only.",
      inputSchema: z.object({
        repository: repositorySchema,
        branch: z.string().min(1).max(255).optional(),
        event: z.string().min(1).max(100).optional(),
        status: z.enum([
          "completed", "action_required", "cancelled", "failure", "neutral", "skipped", "stale",
          "success", "timed_out", "in_progress", "queued", "requested", "waiting", "pending",
        ]).optional(),
        limit: z.number().int().min(1).max(100).default(20),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ repository, branch, event, status, limit }, extra) => auditedTool(audit, "github_list_workflow_runs", extra, { repository }, async () => {
      requireScope(extra, "github:read");
      return await github.listWorkflowRuns(repository, {
        ...(branch === undefined ? {} : { branch }),
        ...(event === undefined ? {} : { event }),
        ...(status === undefined ? {} : { status }),
        limit,
      });
    }),
  );

  server.registerTool(
    "github_get_workflow_run",
    {
      title: "Get GitHub Actions workflow run",
      description: "Read one GitHub Actions workflow run and its conclusion. This tool does not mutate the run.",
      inputSchema: z.object({
        repository: repositorySchema,
        runId: z.number().int().positive(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ repository, runId }, extra) => auditedTool(audit, "github_get_workflow_run", extra, { repository }, async () => {
      requireScope(extra, "github:read");
      return await github.getWorkflowRun(repository, runId);
    }),
  );

  server.registerTool(
    "github_create_change",
    {
      title: "Create an atomic GitHub code change and Pull Request",
      description: [
        "Create or reuse a managed chatgpt/* branch, apply multiple complete-file upserts/deletions in one atomic commit, and create a Pull Request by default.",
        "Read the relevant files first. Include every related file in one call. This is a write operation and may delete files when operation=delete.",
      ].join(" "),
      inputSchema: z.object({
        repository: repositorySchema,
        commitMessage: z.string().min(3).max(256).describe("Concise Git commit message"),
        changes: z.array(fileChangeSchema).min(1).max(config.maxFilesPerChange),
        branch: branchSchema.optional().describe(`Optional managed branch name; ${config.branchPrefix} is added automatically`),
        baseBranch: branchSchema.optional().describe("Base branch for a new Pull Request; defaults to repository default branch"),
        pullRequestTitle: z.string().min(3).max(256).optional(),
        pullRequestBody: z.string().max(60_000).optional(),
        createPullRequest: z.boolean().default(true),
        draftPullRequest: z.boolean().default(false),
        reuseBranch: z.boolean().default(false).describe("Allow appending a new commit to an existing managed branch"),
        expectedHeadSha: z.string().regex(/^[0-9a-f]{40}$/i).optional().describe("Required current branch head when safely reusing a branch"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (input, extra) => auditedTool(
      audit,
      "github_create_change",
      extra,
      {
        repository: input.repository,
        ...(input.branch === undefined ? {} : { branch: input.branch }),
        paths: input.changes.map((change) => change.path),
      },
      async () => {
        requireScope(extra, "github:write");
        return await github.createChange({
          repository: input.repository,
          commitMessage: input.commitMessage,
          changes: input.changes,
          createPullRequest: input.createPullRequest,
          draftPullRequest: input.draftPullRequest,
          reuseBranch: input.reuseBranch,
          ...(input.branch === undefined ? {} : { branch: input.branch }),
          ...(input.baseBranch === undefined ? {} : { baseBranch: input.baseBranch }),
          ...(input.pullRequestTitle === undefined ? {} : { pullRequestTitle: input.pullRequestTitle }),
          ...(input.pullRequestBody === undefined ? {} : { pullRequestBody: input.pullRequestBody }),
          ...(input.expectedHeadSha === undefined ? {} : { expectedHeadSha: input.expectedHeadSha }),
        });
      },
      (result) => [
        `Created commit ${result.commitSha} on ${result.branch}.`,
        `Commit: ${result.commitUrl}`,
        ...(result.pullRequest ? [`Pull Request #${result.pullRequest.number}: ${result.pullRequest.url}`] : []),
        `Changed paths: ${result.changedPaths.join(", ")}`,
      ].join("\n"),
    ),
  );

  server.registerTool(
    "github_comment_pull_request",
    {
      title: "Comment on a Pull Request",
      description: "Add a review, testing, or implementation note to a Pull Request.",
      inputSchema: z.object({
        repository: repositorySchema,
        pullNumber: z.number().int().positive(),
        body: z.string().min(1).max(60_000),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ repository, pullNumber, body }, extra) => auditedTool(audit, "github_comment_pull_request", extra, { repository }, async () => {
      requireScope(extra, "github:write");
      return await github.commentPullRequest(repository, pullNumber, body);
    }),
  );

  if (config.allowMerge) {
    server.registerTool(
      "github_merge_pull_request",
      {
        title: "Merge a Pull Request",
        description: "Merge a Pull Request. This capability is only registered when ALLOW_MERGE=true.",
        inputSchema: z.object({
          repository: repositorySchema,
          pullNumber: z.number().int().positive(),
          method: z.enum(["merge", "squash", "rebase"]).default("squash"),
        }),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      },
      async ({ repository, pullNumber, method }, extra) => auditedTool(audit, "github_merge_pull_request", extra, { repository }, async () => {
        requireScope(extra, "github:merge");
        return await github.mergePullRequest(repository, pullNumber, method);
      }),
    );
  }

  if (config.allowDeleteBranch) {
    server.registerTool(
      "github_delete_branch",
      {
        title: "Delete a managed GitHub branch",
        description: `Delete a non-default branch managed by this service. Only ${config.branchPrefix}* branches are accepted.`,
        inputSchema: z.object({ repository: repositorySchema, branch: branchSchema }),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      },
      async ({ repository, branch }, extra) => auditedTool(audit, "github_delete_branch", extra, { repository, branch }, async () => {
        requireScope(extra, "github:write");
        return await github.deleteBranch(repository, branch);
      }),
    );
  }

  if (localGateway) {
    registerLocalTools(server, {
      gateway: localGateway,
      audit,
      bridgeCapabilities: {
        githubMergeEnabled: config.allowMerge,
        gmailConfigured: gmail !== undefined,
      },
    });
  }

  if (gmail) {
    registerGmailTools(server, { gmail, audit });
  }

  server.registerPrompt(
    "development_workflow",
    {
      title: "Codex-style development workflow",
      description: "Inspect, plan, implement, test, review Git state, optionally verify visual context and CI, then report evidence.",
      argsSchema: {
        repository: repositorySchema,
        task: z.string().min(1).max(20_000),
        workingDirectory: z.string().min(1).max(32_768).optional(),
      },
    },
    async ({ repository, task, workingDirectory }) => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: developmentWorkflowText({
            repository,
            task,
            ...(workingDirectory === undefined ? {} : { workingDirectory }),
          }),
        },
      }],
    }),
  );

  server.registerPrompt(
    "safe_github_development",
    {
      title: "Safely develop a GitHub repository",
      description: "A workflow prompt for inspecting a repository, making an atomic code change, and creating a Pull Request.",
      argsSchema: { repository: repositorySchema },
    },
    async ({ repository }) => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: [
            `Work on ${repository} safely.`,
            "First inspect the repository tree and read every relevant file.",
            "Explain the intended change briefly, then use one github_create_change call with complete contents for all changed files.",
            "Create a Pull Request and report its URL. Do not merge it unless I explicitly request merging and the merge tool is available.",
          ].join(" "),
        },
      }],
    }),
  );

  return server;
}
