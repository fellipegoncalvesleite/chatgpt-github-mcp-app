import { describe, expect, it, vi } from "vitest";
import { testConfig } from "./helpers.js";

const mocks = vi.hoisted(() => {
  const getRef = vi.fn();
  const client = {
    repos: { get: vi.fn() },
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
