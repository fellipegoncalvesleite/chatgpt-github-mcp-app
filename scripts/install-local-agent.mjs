import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

if (process.platform !== "darwin") {
  throw new Error("The LaunchAgent installer is only supported on macOS");
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envArg = process.argv.find((value) => value.startsWith("--env-file="));
const envFile = resolve(envArg?.slice("--env-file=".length) || join(homedir(), ".config", "chatgpt-local-agent.env"));
if (!existsSync(envFile)) {
  throw new Error(`Local-agent environment file does not exist: ${envFile}`);
}

const label = "dev.fellipe.chatgpt-local-agent";
const launchAgents = join(homedir(), "Library", "LaunchAgents");
const plistPath = join(launchAgents, `${label}.plist`);
const logPath = join(homedir(), "Library", "Logs", "chatgpt-local-agent.log");
const distAgent = join(repoRoot, "dist", "local", "agent.js");
mkdirSync(launchAgents, { recursive: true });

const xml = (value) => String(value)
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&apos;");

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xml(label)}</string>
<key>ProgramArguments</key><array>
<string>${xml(process.execPath)}</string>
<string>--env-file=${xml(envFile)}</string>
<string>${xml(distAgent)}</string>
</array>
<key>WorkingDirectory</key><string>${xml(repoRoot)}</string>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>10</integer>
<key>StandardOutPath</key><string>${xml(logPath)}</string>
<key>StandardErrorPath</key><string>${xml(logPath)}</string>
</dict></plist>
`;

writeFileSync(plistPath, plist, { encoding: "utf8", mode: 0o600 });
const domain = `gui/${process.getuid()}`;
spawnSync("/bin/launchctl", ["bootout", domain, plistPath], { stdio: "ignore" });
const loaded = spawnSync("/bin/launchctl", ["bootstrap", domain, plistPath], { stdio: "inherit" });
if (loaded.status !== 0) process.exit(loaded.status ?? 1);
spawnSync("/bin/launchctl", ["kickstart", "-k", `${domain}/${label}`], { stdio: "inherit" });

console.log(`Installed ${label}`);
console.log(`Plist: ${plistPath}`);
console.log(`Environment: ${envFile}`);
console.log(`Log: ${logPath}`);
