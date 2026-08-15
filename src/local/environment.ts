const BRIDGE_SECRET_ENV_KEYS = new Set([
  "LOCAL_AGENT_TOKEN",
  "OAUTH_SIGNING_SECRET",
  "OAUTH_ADMIN_PASSWORD_HASH",
  "GITHUB_PRIVATE_KEY",
  "GITHUB_PRIVATE_KEY_BASE64",
]);

export function localChildEnvironment(overlay?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of BRIDGE_SECRET_ENV_KEYS) delete env[key];
  if (overlay) {
    for (const [key, value] of Object.entries(overlay)) {
      if (!BRIDGE_SECRET_ENV_KEYS.has(key)) env[key] = value;
    }
  }
  return env;
}
