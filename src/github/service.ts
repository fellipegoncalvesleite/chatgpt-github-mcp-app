import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import type { AppConfig } from "../config.js";
import { AppError } from "../errors.js";
import type { FileChange } from "../security/policy.js";
import { SecurityPolicy } from "../security/policy.js";
import { normalizeRepo, splitRepo } from "../utils.js";

export type RepositorySummary = {
  fullName: string;
  defaultBranch: string;
  private: boolean;
  description: string | null;
  htmlUrl: string;
  archived: boolean;
};

export type CreateChangeInput = {
  repository: string;
  changes: FileChange[];
  commitMessage: string;
  branch?: string;
  baseBranch?: string;
  pullRequestTitle?: string;
  pullRequestBody?: string;
  createPullRequest?: boolean;
  draftPullRequest?: boolean;
  reuseBranch?: boolean;
  expectedHeadSha?: string;
};

export type CreateChangeResult = {
  repository: string;
  baseBranch: string;
  branch: string;
  commitSha: string;
  commitUrl: string;
  changedPaths: string[];
  pullRequest?: {
    number: number;
    url: string;
    state: string;
    draft: boolean;
  };
};

function statusOf(error: unknown): number | undefined {
  if (typeof error === "object" && error !== null && "status" in error && typeof error.status === "number") {
    return error.status;
  }
  return undefined;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export class GitHubService {
  private readonly appAuth;

  constructor(
    private readonly config: AppConfig,
    private readonly policy: SecurityPolicy,
  ) {
    this.appAuth = createAppAuth({
      appId: config.githubAppId,
      privateKey: config.githubPrivateKey,
    });
  }

  private async appClient(): Promise<Octokit> {
    const auth = await this.appAuth({ type: "app" });
    return new Octokit({ auth: auth.token });
  }

  private async installationIdFor(repository: string): Promise<number> {
    if (this.config.githubInstallationId) return this.config.githubInstallationId;
    const { owner, repo } = splitRepo(repository);
    const client = await this.appClient();
    const response = await client.request("GET /repos/{owner}/{repo}/installation", { owner, repo });
    return response.data.id;
  }

  private async repositoryClient(repository: string): Promise<Octokit> {
    this.policy.assertRepositoryAllowed(repository);
    const { repo } = splitRepo(repository);
    const installationId = await this.installationIdFor(repository);
    const auth = await this.appAuth({
      type: "installation",
      installationId,
      repositoryNames: [repo],
    });
    return new Octokit({ auth: auth.token });
  }

  private toSummary(data: {
    full_name: string;
    default_branch: string;
    private: boolean;
    description: string | null;
    html_url: string;
    archived: boolean;
  }): RepositorySummary {
    return {
      fullName: data.full_name,
      defaultBranch: data.default_branch,
      private: data.private,
      description: data.description,
      htmlUrl: data.html_url,
      archived: data.archived,
    };
  }

  async listRepositories(): Promise<RepositorySummary[]> {
    if (this.config.allowedRepositories.length > 0) {
      const results: RepositorySummary[] = [];
      for (const repository of this.config.allowedRepositories) {
        try {
          results.push(await this.getRepository(repository));
        } catch (error) {
          if (statusOf(error) !== 404) throw error;
        }
      }
      return results;
    }

    if (!this.config.allowAllInstalledRepos) return [];
    const repositories: RepositorySummary[] = [];
    const appClient = await this.appClient();
    const installations = this.config.githubInstallationId
      ? [{ id: this.config.githubInstallationId }]
      : (await appClient.paginate(appClient.apps.listInstallations, { per_page: 100 })).map((item) => ({ id: item.id }));

    for (const installation of installations) {
      const auth = await this.appAuth({ type: "installation", installationId: installation.id });
      const client = new Octokit({ auth: auth.token });
      const repos = await client.paginate(client.apps.listReposAccessibleToInstallation, { per_page: 100 });
      for (const item of repos) {
        repositories.push(this.toSummary(item));
      }
    }
    return repositories;
  }

  async getRepository(repository: string): Promise<RepositorySummary> {
    const { owner, repo } = splitRepo(repository);
    const client = await this.repositoryClient(repository);
    const response = await client.repos.get({ owner, repo });
    return this.toSummary(response.data);
  }

  async listTree(repository: string, ref?: string, pathPrefix?: string, limit?: number): Promise<{
    repository: string;
    ref: string;
    truncated: boolean;
    entries: Array<{ path: string; type: string; sha: string; size?: number; url?: string }>;
  }> {
    const { owner, repo } = splitRepo(repository);
    const client = await this.repositoryClient(repository);
    const repoInfo = await client.repos.get({ owner, repo });
    const selectedRef = ref ?? repoInfo.data.default_branch;
    const response = await client.git.getTree({ owner, repo, tree_sha: selectedRef, recursive: "1" });
    const prefix = pathPrefix?.replace(/^\/+|\/+$/g, "");
    const max = Math.min(limit ?? this.config.maxTreeEntries, this.config.maxTreeEntries);
    const entries = response.data.tree
      .filter((entry) => entry.path && (!prefix || entry.path === prefix || entry.path.startsWith(`${prefix}/`)))
      .slice(0, max)
      .map((entry) => ({
        path: entry.path!,
        type: entry.type ?? "unknown",
        sha: entry.sha ?? "",
        ...(entry.size === undefined ? {} : { size: entry.size }),
        ...(entry.url === undefined ? {} : { url: entry.url }),
      }));
    return {
      repository: normalizeRepo(repository),
      ref: selectedRef,
      truncated: Boolean(response.data.truncated) || entries.length >= max,
      entries,
    };
  }

  async readFile(repository: string, path: string, ref?: string): Promise<{
    repository: string;
    path: string;
    ref: string;
    sha: string;
    size: number;
    content: string;
    htmlUrl: string | null;
  }> {
    const safePath = this.policy.assertReadablePath(path);
    const { owner, repo } = splitRepo(repository);
    const client = await this.repositoryClient(repository);
    const repoInfo = await client.repos.get({ owner, repo });
    const selectedRef = ref ?? repoInfo.data.default_branch;
    const response = await client.repos.getContent({ owner, repo, path: safePath, ref: selectedRef });
    if (Array.isArray(response.data) || response.data.type !== "file" || !("content" in response.data)) {
      throw new AppError("not_a_file", `${safePath} is not a regular file`);
    }
    if (response.data.size > this.config.maxReadFileBytes) {
      throw new AppError("read_file_too_large", `${safePath} exceeds MAX_READ_FILE_BYTES (${this.config.maxReadFileBytes})`, 413);
    }
    const content = Buffer.from(response.data.content.replaceAll("\n", ""), "base64").toString("utf8");
    return {
      repository: normalizeRepo(repository),
      path: safePath,
      ref: selectedRef,
      sha: response.data.sha,
      size: response.data.size,
      content,
      htmlUrl: response.data.html_url,
    };
  }

  async listPullRequests(repository: string, state: "open" | "closed" | "all" = "open", limit = 20): Promise<Array<{
    number: number;
    title: string;
    state: string;
    draft: boolean;
    head: string;
    base: string;
    url: string;
    updatedAt: string;
  }>> {
    const { owner, repo } = splitRepo(repository);
    const client = await this.repositoryClient(repository);
    const response = await client.pulls.list({ owner, repo, state, per_page: Math.min(limit, 100) });
    return response.data.map((item) => ({
      number: item.number,
      title: item.title,
      state: item.state,
      draft: Boolean(item.draft),
      head: item.head.ref,
      base: item.base.ref,
      url: item.html_url,
      updatedAt: item.updated_at,
    }));
  }

  async getPullRequest(repository: string, pullNumber: number): Promise<{
    number: number;
    title: string;
    state: string;
    draft: boolean;
    mergeable: boolean | null;
    head: string;
    base: string;
    url: string;
    body: string | null;
    files: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }>;
  }> {
    const { owner, repo } = splitRepo(repository);
    const client = await this.repositoryClient(repository);
    const [pr, files] = await Promise.all([
      client.pulls.get({ owner, repo, pull_number: pullNumber }),
      client.paginate(client.pulls.listFiles, { owner, repo, pull_number: pullNumber, per_page: 100 }),
    ]);
    return {
      number: pr.data.number,
      title: pr.data.title,
      state: pr.data.state,
      draft: Boolean(pr.data.draft),
      mergeable: pr.data.mergeable,
      head: pr.data.head.ref,
      base: pr.data.base.ref,
      url: pr.data.html_url,
      body: pr.data.body,
      files: files.map((file) => ({
        filename: file.filename,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        changes: file.changes,
      })),
    };
  }

  async getCheckStatus(repository: string, ref: string): Promise<{
    repository: string;
    ref: string;
    state: "none" | "pending" | "passing" | "failing";
    checkRuns: Array<{
      id: number;
      name: string;
      status: string;
      conclusion: string | null;
      detailsUrl: string | null;
      startedAt: string | null;
      completedAt: string | null;
    }>;
    commitStatus: { state: string; totalCount: number };
  }> {
    const { owner, repo } = splitRepo(repository);
    const client = await this.repositoryClient(repository);
    const [checks, combined] = await Promise.all([
      client.checks.listForRef({ owner, repo, ref, per_page: 100 }),
      client.repos.getCombinedStatusForRef({ owner, repo, ref }),
    ]);
    const checkRuns = checks.data.check_runs.map((run) => ({
      id: run.id,
      name: run.name,
      status: run.status,
      conclusion: run.conclusion,
      detailsUrl: run.details_url,
      startedAt: run.started_at,
      completedAt: run.completed_at,
    }));
    const failureConclusions = new Set(["failure", "cancelled", "timed_out", "action_required", "startup_failure", "stale"]);
    const hasLegacyStatuses = combined.data.total_count > 0;
    const hasFailure = checkRuns.some((run) => run.conclusion !== null && failureConclusions.has(run.conclusion))
      || (hasLegacyStatuses && (combined.data.state === "failure" || combined.data.state === "error"));
    const hasPending = checkRuns.some((run) => run.status !== "completed")
      || (hasLegacyStatuses && combined.data.state === "pending");
    const hasAny = checkRuns.length > 0 || hasLegacyStatuses;
    const state = !hasAny ? "none" : hasFailure ? "failing" : hasPending ? "pending" : "passing";
    return {
      repository: normalizeRepo(repository),
      ref,
      state,
      checkRuns,
      commitStatus: { state: combined.data.state, totalCount: combined.data.total_count },
    };
  }

  async listWorkflowRuns(
    repository: string,
    options: { branch?: string; status?: string; event?: string; limit?: number } = {},
  ): Promise<{ totalCount: number; runs: Array<{
    id: number;
    name: string | null;
    runNumber: number;
    attempt: number | null;
    event: string;
    status: string | null;
    conclusion: string | null;
    headBranch: string | null;
    headSha: string;
    url: string;
    createdAt: string;
    updatedAt: string;
    workflowId: number;
  }> }> {
    const { owner, repo } = splitRepo(repository);
    const client = await this.repositoryClient(repository);
    const response = await client.actions.listWorkflowRunsForRepo({
      owner,
      repo,
      per_page: Math.min(Math.max(options.limit ?? 20, 1), 100),
      ...(options.branch === undefined ? {} : { branch: options.branch }),
      ...(options.event === undefined ? {} : { event: options.event }),
      ...(options.status === undefined ? {} : { status: options.status as never }),
    });
    return {
      totalCount: response.data.total_count,
      runs: response.data.workflow_runs.map((run) => ({
        id: run.id,
        name: run.name ?? null,
        runNumber: run.run_number,
        attempt: run.run_attempt ?? null,
        event: run.event,
        status: run.status,
        conclusion: run.conclusion,
        headBranch: run.head_branch,
        headSha: run.head_sha,
        url: run.html_url,
        createdAt: run.created_at,
        updatedAt: run.updated_at,
        workflowId: run.workflow_id,
      })),
    };
  }

  async getWorkflowRun(repository: string, runId: number): Promise<{
    id: number;
    name: string | null;
    runNumber: number;
    attempt: number | null;
    event: string;
    status: string | null;
    conclusion: string | null;
    headBranch: string | null;
    headSha: string;
    url: string;
    createdAt: string;
    updatedAt: string;
    workflowId: number;
  }> {
    const { owner, repo } = splitRepo(repository);
    const client = await this.repositoryClient(repository);
    const response = await client.actions.getWorkflowRun({ owner, repo, run_id: runId });
    const run = response.data;
    return {
      id: run.id,
      name: run.name ?? null,
      runNumber: run.run_number,
      attempt: run.run_attempt ?? null,
      event: run.event,
      status: run.status,
      conclusion: run.conclusion,
      headBranch: run.head_branch,
      headSha: run.head_sha,
      url: run.html_url,
      createdAt: run.created_at,
      updatedAt: run.updated_at,
      workflowId: run.workflow_id,
    };
  }

  async createChange(input: CreateChangeInput): Promise<CreateChangeResult> {
    const repository = normalizeRepo(input.repository);
    const validatedChanges = this.policy.validateChanges(input.changes);
    const { owner, repo } = splitRepo(repository);
    const client = await this.repositoryClient(repository);
    const repoInfo = await client.repos.get({ owner, repo });
    const baseBranch = input.baseBranch ?? repoInfo.data.default_branch;
    const branch = this.policy.makeBranchName(input.branch, input.commitMessage.split(/\s+/).slice(0, 5).join("-"));
    this.policy.assertTargetBranchAllowed(branch, repoInfo.data.default_branch);

    const baseRef = await client.git.getRef({ owner, repo, ref: `heads/${baseBranch}` });
    let parentSha = baseRef.data.object.sha;
    let branchExists = false;
    try {
      const targetRef = await client.git.getRef({ owner, repo, ref: `heads/${branch}` });
      branchExists = true;
      parentSha = targetRef.data.object.sha;
      if (!input.reuseBranch) {
        throw new AppError("branch_exists", `Branch ${branch} already exists; set reuseBranch=true to append a commit`, 409);
      }
      if (input.expectedHeadSha && input.expectedHeadSha !== parentSha) {
        throw new AppError("head_sha_mismatch", `Expected ${input.expectedHeadSha}, but ${branch} is at ${parentSha}`, 409);
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (statusOf(error) !== 404) throw error;
      await client.git.createRef({ owner, repo, ref: `refs/heads/${branch}`, sha: parentSha });
    }

    try {
      const parentCommit = await client.git.getCommit({ owner, repo, commit_sha: parentSha });
      const treeEntries: Array<Record<string, unknown>> = [];
      for (const change of validatedChanges) {
        if (change.operation === "delete") {
          treeEntries.push({ path: change.path, mode: "100644", type: "blob", sha: null });
        } else {
          const blob = await client.git.createBlob({ owner, repo, content: change.content, encoding: "utf-8" });
          treeEntries.push({ path: change.path, mode: "100644", type: "blob", sha: blob.data.sha });
        }
      }
      const tree = await client.git.createTree({
        owner,
        repo,
        base_tree: parentCommit.data.tree.sha,
        tree: treeEntries as never,
      });
      const commit = await client.git.createCommit({
        owner,
        repo,
        message: input.commitMessage,
        tree: tree.data.sha,
        parents: [parentSha],
      });
      await client.git.updateRef({ owner, repo, ref: `heads/${branch}`, sha: commit.data.sha, force: false });

      const result: CreateChangeResult = {
        repository,
        baseBranch,
        branch,
        commitSha: commit.data.sha,
        commitUrl: `https://github.com/${repository}/commit/${commit.data.sha}`,
        changedPaths: validatedChanges.map((change) => change.path),
      };

      if (input.createPullRequest ?? true) {
        const existing = await client.pulls.list({ owner, repo, state: "open", head: `${owner}:${branch}`, base: baseBranch, per_page: 1 });
        const pr = existing.data[0] ?? (await client.pulls.create({
          owner,
          repo,
          head: branch,
          base: baseBranch,
          title: input.pullRequestTitle ?? input.commitMessage,
          body: input.pullRequestBody ?? "Created from ChatGPT through the self-hosted GitHub MCP App.",
          draft: input.draftPullRequest ?? false,
        })).data;
        result.pullRequest = {
          number: pr.number,
          url: pr.html_url,
          state: pr.state,
          draft: Boolean(pr.draft),
        };
      }
      return result;
    } catch (error) {
      if (!branchExists) {
        try {
          await client.git.deleteRef({ owner, repo, ref: `heads/${branch}` });
        } catch {
          // Best-effort rollback only. The original error is more important.
        }
      }
      throw new AppError("github_change_failed", messageOf(error), statusOf(error) ?? 500);
    }
  }

  async commentPullRequest(repository: string, pullNumber: number, body: string): Promise<{ url: string }> {
    const { owner, repo } = splitRepo(repository);
    const client = await this.repositoryClient(repository);
    const response = await client.issues.createComment({ owner, repo, issue_number: pullNumber, body });
    return { url: response.data.html_url };
  }

  async mergePullRequest(repository: string, pullNumber: number, method: "merge" | "squash" | "rebase" = "squash"): Promise<{
    merged: boolean;
    message: string;
    sha: string | null;
  }> {
    this.policy.assertMergeAllowed();
    const { owner, repo } = splitRepo(repository);
    const client = await this.repositoryClient(repository);
    const response = await client.pulls.merge({ owner, repo, pull_number: pullNumber, merge_method: method });
    return { merged: response.data.merged, message: response.data.message, sha: response.data.sha };
  }

  async deleteBranch(repository: string, branch: string): Promise<{ deleted: boolean; branch: string }> {
    this.policy.assertDeleteBranchAllowed();
    const { owner, repo } = splitRepo(repository);
    const client = await this.repositoryClient(repository);
    const info = await client.repos.get({ owner, repo });
    if (branch === info.data.default_branch) throw new AppError("cannot_delete_default_branch", "Cannot delete the default branch", 403);
    const prefix = this.config.branchPrefix.endsWith("/") ? this.config.branchPrefix : `${this.config.branchPrefix}/`;
    if (!branch.startsWith(prefix)) throw new AppError("branch_not_managed", `Only ${prefix}* branches may be deleted`, 403);
    await client.git.deleteRef({ owner, repo, ref: `heads/${branch}` });
    return { deleted: true, branch };
  }
}
