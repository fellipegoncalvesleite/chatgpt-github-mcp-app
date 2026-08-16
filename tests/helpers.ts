import { scryptSync } from "node:crypto";
import type { AppConfig } from "../src/config.js";
import type { GitHubToolService } from "../src/mcp.js";

export function adminPasswordHash(password = "test-password"): string {
  const salt = Buffer.from("chatgpt-github-mcp-test-salt");
  const hash = scryptSync(password, salt, 64);
  return `scrypt:${salt.toString("base64url")}:${hash.toString("base64url")}`;
}

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    nodeEnv: "test",
    port: 3000,
    publicBaseUrl: new URL("http://localhost:3000"),
    githubAppId: "1",
    githubPrivateKey: "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----",
    allowedRepositories: ["acme/demo"],
    allowAllInstalledRepos: false,
    branchPrefix: "chatgpt/",
    allowDefaultBranchWrite: false,
    allowMerge: false,
    allowDeleteBranch: false,
    allowWorkflowEdits: false,
    protectedPathPatterns: ["**/.env", "**/.env.*", "**/*.pem", "**/*.key"],
    maxFilesPerChange: 30,
    maxFileBytes: 300_000,
    maxReadFileBytes: 1_000_000,
    maxTotalChangeBytes: 2_000_000,
    maxTreeEntries: 5_000,
    maxHttpBodyBytes: 3_000_000,
    oauthSigningSecret: "test-signing-secret-which-is-long-enough-for-hmac",
    oauthAdminPasswordHash: adminPasswordHash(),
    oauthStorePath: "/tmp/chatgpt-github-mcp-oauth-test.json",
    oauthAllowedRedirectHosts: ["chatgpt.com", "localhost", "127.0.0.1"],
    accessTokenTtlSeconds: 900,
    refreshTokenTtlSeconds: 3600,
    auditLogPath: "/tmp/chatgpt-github-mcp-audit-test.jsonl",
    gmailClientId: "",
    gmailClientSecret: "",
    gmailRefreshToken: "",
    gmailAccountEmail: "",
    localAgentToken: "local-agent-test-token-which-is-long-enough",
    localAgentRpcTimeoutMs: 2_000,
    localAgentPollWaitMs: 1_000,
    localAgentMaxOutputBytes: 100_000,
    localAgentMaxFileBytes: 100_000,
    localAgentMaxTerminalBytes: 100_000,
    localAgentMaxSessions: 4,
    localAgentMaxCommandTimeoutMs: 5_000,
    ...overrides,
  };
}

export function fakeGitHubService(overrides: Partial<GitHubToolService> = {}): GitHubToolService {
  return {
    async listRepositories() {
      return [{
        fullName: "acme/demo",
        defaultBranch: "main",
        private: true,
        description: "demo",
        htmlUrl: "https://github.com/acme/demo",
        archived: false,
      }];
    },
    async getRepository(repository) {
      return {
        fullName: repository,
        defaultBranch: "main",
        private: true,
        description: "demo",
        htmlUrl: `https://github.com/${repository}`,
        archived: false,
      };
    },
    async listTree(repository, ref = "main") {
      return {
        repository,
        ref,
        truncated: false,
        entries: [{ path: "README.md", type: "blob", sha: "a".repeat(40), size: 5 }],
      };
    },
    async readFile(repository, path, ref = "main") {
      return {
        repository,
        path,
        ref,
        sha: "a".repeat(40),
        size: 5,
        content: "hello",
        htmlUrl: `https://github.com/${repository}/blob/${ref}/${path}`,
      };
    },
    async listPullRequests() { return []; },
    async getPullRequest(_repository, pullNumber) {
      return {
        number: pullNumber,
        title: "Demo PR",
        state: "open",
        draft: false,
        mergeable: true,
        head: "chatgpt/demo",
        base: "main",
        url: "https://github.com/acme/demo/pull/1",
        body: null,
        files: [],
      };
    },
    async createChange(input) {
      return {
        repository: input.repository,
        baseBranch: input.baseBranch ?? "main",
        branch: input.branch ?? "chatgpt/demo",
        commitSha: "b".repeat(40),
        commitUrl: `https://github.com/${input.repository}/commit/${"b".repeat(40)}`,
        changedPaths: input.changes.map((change) => change.path),
        pullRequest: { number: 1, url: `https://github.com/${input.repository}/pull/1`, state: "open", draft: false },
      };
    },
    async commentPullRequest() { return { url: "https://github.com/acme/demo/pull/1#issuecomment-1" }; },
    async mergePullRequest() { return { merged: true, message: "merged", sha: "c".repeat(40) }; },
    async deleteBranch(_repository, branch) { return { deleted: true, branch }; },
    ...overrides,
  };
}
