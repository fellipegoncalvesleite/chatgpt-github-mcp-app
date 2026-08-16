import { beforeEach, describe, expect, it, vi } from "vitest";
import { testConfig } from "./helpers.js";

const mocks = vi.hoisted(() => {
  const getRef = vi.fn();
  const client = {
    repos: { get: vi.fn(), getCombinedStatusForRef: vi.fn() },
    checks: { listForRef: vi.fn() },
    actions: { listWorkflowRunsForRepo: vi.fn(), getWorkflowRun: vi.fn() },
    git: {
      getRef,
      createRef: vi.fn(),
      getCommit: vi.fn(),
      createBlob: vi.fn(),
      createTree: vi.fn(),
      createCommit: vi.fn(),
      updateRef: vi.fn(),
      deleteRef: vi.fn(),
    },
    pulls: { list: vi.fn(), create: vi.fn() },
  };
  return { client, getRef };
});

vi.mock("@octokit/auth-app", () => ({
  createAppAuth: () => async () => ({ token: "installation-token" }),
}));

vi.mock("@octokit/rest", () => ({
  Octokit: class {
    constructor() {
      return mocks.client;
    }
  },
}));

import { GitHubService } from "../src/github/service.js";
import { SecurityPolicy } from "../src/security/policy.js";


beforeEach(() => {
  vi.clearAllMocks();
});

describe("GitHubService CI awareness", () => {
  it("summarizes checks for a ref without mutating GitHub", async () => {
    const config = testConfig({ githubInstallationId: 123 });
    const service = new GitHubService(config, new SecurityPolicy(config));
    mocks.client.checks.listForRef.mockResolvedValue({
      data: {
        total_count: 2,
        check_runs: [
          { id: 1, name: "test", status: "completed", conclusion: "success", details_url: "https://example.test/check/1", started_at: "2026-08-16T20:00:00Z", completed_at: "2026-08-16T20:01:00Z" },
          { id: 2, name: "lint", status: "in_progress", conclusion: null, details_url: "https://example.test/check/2", started_at: "2026-08-16T20:00:30Z", completed_at: null },
        ],
      },
    });
    mocks.client.repos.getCombinedStatusForRef.mockResolvedValue({
      data: { state: "pending", total_count: 1, statuses: [] },
    });

    await expect(service.getCheckStatus("acme/demo", "abc123")).resolves.toMatchObject({
      repository: "acme/demo",
      ref: "abc123",
      state: "pending",
      checkRuns: [
        expect.objectContaining({ name: "test", status: "completed", conclusion: "success" }),
        expect.objectContaining({ name: "lint", status: "in_progress", conclusion: null }),
      ],
      commitStatus: { state: "pending", totalCount: 1 },
    });
    expect(mocks.client.checks.listForRef).toHaveBeenCalledWith(expect.objectContaining({ owner: "acme", repo: "demo", ref: "abc123" }));
  });

  it("lists and reads GitHub Actions workflow runs", async () => {
    const config = testConfig({ githubInstallationId: 123 });
    const service = new GitHubService(config, new SecurityPolicy(config));
    mocks.client.actions.listWorkflowRunsForRepo.mockResolvedValue({
      data: {
        total_count: 1,
        workflow_runs: [{
          id: 42, name: "CI", run_number: 7, run_attempt: 1, event: "pull_request", status: "completed", conclusion: "success", head_branch: "chatgpt/demo", head_sha: "a".repeat(40), html_url: "https://github.com/acme/demo/actions/runs/42", created_at: "2026-08-16T20:00:00Z", updated_at: "2026-08-16T20:02:00Z", workflow_id: 9,
        }],
      },
    });
    mocks.client.actions.getWorkflowRun.mockResolvedValue({
      data: {
        id: 42, name: "CI", run_number: 7, run_attempt: 1, event: "pull_request", status: "completed", conclusion: "success", head_branch: "chatgpt/demo", head_sha: "a".repeat(40), html_url: "https://github.com/acme/demo/actions/runs/42", created_at: "2026-08-16T20:00:00Z", updated_at: "2026-08-16T20:02:00Z", workflow_id: 9,
      },
    });

    await expect(service.listWorkflowRuns("acme/demo", { branch: "chatgpt/demo", status: "completed", limit: 10 })).resolves.toMatchObject({
      totalCount: 1,
      runs: [expect.objectContaining({ id: 42, name: "CI", conclusion: "success" })],
    });
    await expect(service.getWorkflowRun("acme/demo", 42)).resolves.toMatchObject({ id: 42, runNumber: 7, conclusion: "success" });
  });
});

describe("GitHubService.createChange", () => {
  it("creates a branch, one tree/commit, updates the ref without force, and opens a PR", async () => {
    const config = testConfig({ githubInstallationId: 123 });
    const policy = new SecurityPolicy(config);
    const service = new GitHubService(config, policy);

    mocks.client.repos.get.mockResolvedValue({ data: { default_branch: "main" } });
    mocks.getRef
      .mockResolvedValueOnce({ data: { object: { sha: "a".repeat(40) } } })
      .mockRejectedValueOnce(Object.assign(new Error("not found"), { status: 404 }));
    mocks.client.git.createRef.mockResolvedValue({ data: {} });
    mocks.client.git.getCommit.mockResolvedValue({ data: { tree: { sha: "t".repeat(40) } } });
    mocks.client.git.createBlob.mockResolvedValue({ data: { sha: "b".repeat(40) } });
    mocks.client.git.createTree.mockResolvedValue({ data: { sha: "c".repeat(40) } });
    mocks.client.git.createCommit.mockResolvedValue({ data: { sha: "d".repeat(40) } });
    mocks.client.git.updateRef.mockResolvedValue({ data: {} });
    mocks.client.pulls.list.mockResolvedValue({ data: [] });
    mocks.client.pulls.create.mockResolvedValue({
      data: { number: 9, html_url: "https://github.com/acme/demo/pull/9", state: "open", draft: false },
    });

    const result = await service.createChange({
      repository: "acme/demo",
      branch: "feature/readme",
      commitMessage: "Update README",
      changes: [
        { path: "README.md", operation: "upsert", content: "new text" },
        { path: "old.txt", operation: "delete" },
      ],
    });

    expect(mocks.client.git.createRef).toHaveBeenCalledWith(expect.objectContaining({
      ref: "refs/heads/chatgpt/feature/readme",
      sha: "a".repeat(40),
    }));
    expect(mocks.client.git.createTree).toHaveBeenCalledWith(expect.objectContaining({
      base_tree: "t".repeat(40),
      tree: expect.arrayContaining([
        expect.objectContaining({ path: "README.md", sha: "b".repeat(40) }),
        expect.objectContaining({ path: "old.txt", sha: null }),
      ]),
    }));
    expect(mocks.client.git.createCommit).toHaveBeenCalledTimes(1);
    expect(mocks.client.git.updateRef).toHaveBeenCalledWith(expect.objectContaining({ force: false }));
    expect(mocks.client.pulls.create).toHaveBeenCalledWith(expect.objectContaining({
      head: "chatgpt/feature/readme",
      base: "main",
    }));
    expect(mocks.client.git.deleteRef).not.toHaveBeenCalled();
    expect(result.pullRequest?.number).toBe(9);
  });
});
