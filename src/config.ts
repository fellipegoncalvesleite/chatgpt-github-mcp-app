import "dotenv/config";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod/v4";
import { asBoolean, asInteger, csv, normalizeRepo } from "./utils.js";

const configSchema = z.object({
  nodeEnv: z.enum(["development", "test", "production"]),
  port: z.number().int().min(1).max(65535),
  publicBaseUrl: z.instanceof(URL),
  githubAppId: z.string().min(1),
  githubPrivateKey: z.string().includes("PRIVATE KEY"),
  githubInstallationId: z.number().int().positive().optional(),
  allowedRepositories: z.array(z.string()),
  allowAllInstalledRepos: z.boolean(),
  branchPrefix: z.string().min(1),
  allowDefaultBranchWrite: z.boolean(),
  allowMerge: z.boolean(),
  allowDeleteBranch: z.boolean(),
  allowWorkflowEdits: z.boolean(),
  protectedPathPatterns: z.array(z.string()),
  maxFilesPerChange: z.number().int().min(1).max(200),
  maxFileBytes: z.number().int().min(1),
  maxReadFileBytes: z.number().int().min(1),
  maxTotalChangeBytes: z.number().int().min(1),
  maxTreeEntries: z.number().int().min(1).max(100000),
  maxHttpBodyBytes: z.number().int().min(100_000).max(100_000_000),
  oauthSigningSecret: z.string().min(32),
  oauthAdminPasswordHash: z.string().startsWith("scrypt:"),
  oauthStorePath: z.string().min(1),
  oauthAllowedRedirectHosts: z.array(z.string()),
  accessTokenTtlSeconds: z.number().int().min(60).max(86400),
  refreshTokenTtlSeconds: z.number().int().min(300),
  auditLogPath: z.string().min(1),
  localAgentToken: z.string(),
  localAgentRpcTimeoutMs: z.number().int().min(1_000).max(600_000),
  localAgentPollWaitMs: z.number().int().min(1_000).max(30_000),
  localAgentMaxOutputBytes: z.number().int().min(1_024),
  localAgentMaxFileBytes: z.number().int().min(1_024),
  localAgentMaxTerminalBytes: z.number().int().min(1_024),
  localAgentMaxSessions: z.number().int().min(1).max(100),
  localAgentMaxCommandTimeoutMs: z.number().int().min(1_000).max(600_000),
});

export type AppConfig = z.infer<typeof configSchema>;

function loadPrivateKey(env: NodeJS.ProcessEnv): string {
  if (env.GITHUB_PRIVATE_KEY_BASE64) {
    return Buffer.from(env.GITHUB_PRIVATE_KEY_BASE64, "base64").toString("utf8").replaceAll("\\n", "\n");
  }
  if (env.GITHUB_PRIVATE_KEY) return env.GITHUB_PRIVATE_KEY.replaceAll("\\n", "\n");
  if (env.GITHUB_PRIVATE_KEY_PATH) return readFileSync(resolve(env.GITHUB_PRIVATE_KEY_PATH), "utf8");
  throw new Error("Set GITHUB_PRIVATE_KEY_PATH, GITHUB_PRIVATE_KEY, or GITHUB_PRIVATE_KEY_BASE64");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = (env.NODE_ENV ?? "development") as AppConfig["nodeEnv"];
  const publicBaseUrl = new URL(env.PUBLIC_BASE_URL ?? "http://localhost:3000");
  if (nodeEnv === "production" && publicBaseUrl.protocol !== "https:") {
    throw new Error("PUBLIC_BASE_URL must use HTTPS in production");
  }

  const allowedRepositories = csv(env.GITHUB_ALLOWED_REPOSITORIES).map(normalizeRepo);
  const allowAllInstalledRepos = asBoolean(env.ALLOW_ALL_INSTALLED_REPOS, false);
  if (nodeEnv === "production" && allowedRepositories.length === 0 && !allowAllInstalledRepos) {
    throw new Error("Production requires GITHUB_ALLOWED_REPOSITORIES or ALLOW_ALL_INSTALLED_REPOS=true");
  }

  return configSchema.parse({
    nodeEnv,
    port: asInteger(env.PORT, 3000),
    publicBaseUrl,
    githubAppId: env.GITHUB_APP_ID ?? "",
    githubPrivateKey: loadPrivateKey(env),
    githubInstallationId: env.GITHUB_INSTALLATION_ID ? asInteger(env.GITHUB_INSTALLATION_ID, 0) : undefined,
    allowedRepositories,
    allowAllInstalledRepos,
    branchPrefix: env.BRANCH_PREFIX ?? "chatgpt/",
    allowDefaultBranchWrite: asBoolean(env.ALLOW_DEFAULT_BRANCH_WRITE, false),
    allowMerge: asBoolean(env.ALLOW_MERGE, false),
    allowDeleteBranch: asBoolean(env.ALLOW_DELETE_BRANCH, false),
    allowWorkflowEdits: asBoolean(env.ALLOW_WORKFLOW_EDITS, false),
    protectedPathPatterns: csv(env.PROTECTED_PATH_PATTERNS ?? "**/.env,**/.env.*,**/*.pem,**/*.key,**/id_rsa,**/id_ed25519"),
    maxFilesPerChange: asInteger(env.MAX_FILES_PER_CHANGE, 30),
    maxFileBytes: asInteger(env.MAX_FILE_BYTES, 300_000),
    maxReadFileBytes: asInteger(env.MAX_READ_FILE_BYTES, 1_000_000),
    maxTotalChangeBytes: asInteger(env.MAX_TOTAL_CHANGE_BYTES, 2_000_000),
    maxTreeEntries: asInteger(env.MAX_TREE_ENTRIES, 5_000),
    maxHttpBodyBytes: asInteger(env.MAX_HTTP_BODY_BYTES, 3_000_000),
    oauthSigningSecret: env.OAUTH_SIGNING_SECRET ?? "",
    oauthAdminPasswordHash: env.OAUTH_ADMIN_PASSWORD_HASH ?? "",
    oauthStorePath: env.OAUTH_STORE_PATH ?? "data/oauth-store.json",
    oauthAllowedRedirectHosts: csv(env.OAUTH_ALLOWED_REDIRECT_HOSTS ?? "chatgpt.com,openai.com,localhost,127.0.0.1"),
    accessTokenTtlSeconds: asInteger(env.ACCESS_TOKEN_TTL_SECONDS, 900),
    refreshTokenTtlSeconds: asInteger(env.REFRESH_TOKEN_TTL_SECONDS, 2_592_000),
    auditLogPath: env.AUDIT_LOG_PATH ?? "data/audit.jsonl",
    localAgentToken: env.LOCAL_AGENT_TOKEN ?? "",
    localAgentRpcTimeoutMs: asInteger(env.LOCAL_AGENT_RPC_TIMEOUT_MS, 300_000),
    localAgentPollWaitMs: asInteger(env.LOCAL_AGENT_POLL_WAIT_MS, 25_000),
    localAgentMaxOutputBytes: asInteger(env.LOCAL_AGENT_MAX_OUTPUT_BYTES, 500_000),
    localAgentMaxFileBytes: asInteger(env.LOCAL_AGENT_MAX_FILE_BYTES, 1_000_000),
    localAgentMaxTerminalBytes: asInteger(env.LOCAL_AGENT_MAX_TERMINAL_BYTES, 1_000_000),
    localAgentMaxSessions: asInteger(env.LOCAL_AGENT_MAX_SESSIONS, 16),
    localAgentMaxCommandTimeoutMs: asInteger(env.LOCAL_AGENT_MAX_COMMAND_TIMEOUT_MS, 120_000),
  });
}
