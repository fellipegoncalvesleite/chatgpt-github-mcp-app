import { randomBytes } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

export const GMAIL_MODIFY_SCOPE = "https://www.googleapis.com/auth/gmail.modify";
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

export function buildAuthorizationUrl({ clientId, redirectUri, state }) {
  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GMAIL_MODIFY_SCOPE);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("state", state);
  return url;
}

export async function writeRefreshTokenFile(path, refreshToken) {
  if (!refreshToken || /[\r\n]/.test(refreshToken)) throw new Error("Invalid Gmail refresh token");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `GMAIL_REFRESH_TOKEN=${refreshToken}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
}

function openBrowser(url) {
  const child = spawn("open", [url], { detached: true, stdio: "ignore" });
  child.unref();
}

function callbackCode({ port, expectedState, timeoutMs = 5 * 60_000 }) {
  let server;
  const promise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      server?.close();
      reject(new Error("Timed out waiting for Google OAuth callback"));
    }, timeoutMs);
    timeout.unref?.();

    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      if (url.pathname !== "/callback") {
        res.writeHead(404).end("Not found");
        return;
      }
      const state = url.searchParams.get("state");
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      if (error) {
        clearTimeout(timeout);
        res.writeHead(400, { "content-type": "text/plain; charset=utf-8" }).end("Google authorization was denied. You can close this tab.");
        server.close();
        reject(new Error(`Google authorization failed: ${error}`));
        return;
      }
      if (state !== expectedState || !code) {
        res.writeHead(400, { "content-type": "text/plain; charset=utf-8" }).end("Invalid OAuth callback. You can close this tab.");
        return;
      }
      clearTimeout(timeout);
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end("Gmail authorization complete. You can close this tab.");
      server.close();
      resolve(code);
    });
    server.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    server.listen(port, "127.0.0.1");
  });
  return { promise, close: () => server?.close() };
}

async function exchangeCode({ clientId, clientSecret, code, redirectUri, fetchImpl = fetch }) {
  const response = await fetchImpl(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!response.ok) throw new Error(`Google token exchange failed with status ${response.status}`);
  const payload = await response.json();
  if (typeof payload.refresh_token !== "string" || !payload.refresh_token) {
    throw new Error("Google did not return a refresh token. Revoke the app grant and run the helper again with consent.");
  }
  return payload.refresh_token;
}

async function main() {
  const clientId = process.env.GMAIL_CLIENT_ID ?? "";
  const clientSecret = process.env.GMAIL_CLIENT_SECRET ?? "";
  if (!clientId || !clientSecret) {
    throw new Error("Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET before running npm run gmail:authorize");
  }
  const parsedPort = Number(process.env.GMAIL_OAUTH_PORT ?? "53682");
  if (!Number.isInteger(parsedPort) || parsedPort < 1024 || parsedPort > 65535) throw new Error("GMAIL_OAUTH_PORT must be an integer from 1024 to 65535");
  const redirectUri = `http://127.0.0.1:${parsedPort}/callback`;
  const outputPath = process.env.GMAIL_REFRESH_TOKEN_OUTPUT ?? join(homedir(), ".config", "chatgpt-gmail.env");
  const state = randomBytes(24).toString("base64url");
  const callback = callbackCode({ port: parsedPort, expectedState: state });
  const authUrl = buildAuthorizationUrl({ clientId, redirectUri, state });
  console.log(`Opening Google authorization for ${GMAIL_MODIFY_SCOPE}.`);
  console.log(`Callback: ${redirectUri}`);
  console.log("The refresh token will be written to a local 0600 file and will not be printed.");
  openBrowser(authUrl.href);
  try {
    const code = await callback.promise;
    const refreshToken = await exchangeCode({ clientId, clientSecret, code, redirectUri });
    await writeRefreshTokenFile(outputPath, refreshToken);
    console.log(`Gmail refresh token saved securely to ${outputPath}.`);
  } finally {
    callback.close();
  }
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
