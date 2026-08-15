import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

if (process.platform !== "darwin") {
  throw new Error("The LaunchAgent uninstaller is only supported on macOS");
}

const label = "dev.fellipe.chatgpt-local-agent";
const plistPath = join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
const domain = `gui/${process.getuid()}`;

if (existsSync(plistPath)) {
  spawnSync("/bin/launchctl", ["bootout", domain, plistPath], { stdio: "inherit" });
  rmSync(plistPath, { force: true });
}
console.log(`Removed ${label}`);
