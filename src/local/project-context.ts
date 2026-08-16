import { execFile } from "node:child_process";
import { access, readFile, realpath } from "node:fs/promises";
import { resolve, relative, sep } from "node:path";
import { promisify } from "node:util";
import { localChildEnvironment } from "./environment.js";
import { LocalExecutionError } from "./protocol.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[], allowFailure = false): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      env: localChildEnvironment(),
      maxBuffer: 2_000_000,
      encoding: "utf8",
    });
    return stdout;
  } catch (error) {
    if (allowFailure) return "";
    throw new LocalExecutionError("git_command_failed", error instanceof Error ? error.message : String(error));
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function parseStatus(status: string): { modifiedFiles: string[]; untrackedFiles: string[]; dirty: boolean } {
  const modifiedFiles: string[] = [];
  const untrackedFiles: string[] = [];
  for (const line of status.split("\n")) {
    if (!line) continue;
    const code = line.slice(0, 2);
    const rawPath = line.slice(3).trim();
    const path = rawPath.includes(" -> ") ? rawPath.split(" -> ").at(-1)! : rawPath;
    if (code === "??") untrackedFiles.push(path);
    else modifiedFiles.push(path);
  }
  return {
    modifiedFiles: unique(modifiedFiles),
    untrackedFiles: unique(untrackedFiles),
    dirty: modifiedFiles.length > 0 || untrackedFiles.length > 0,
  };
}

function commandForScript(packageManager: string, script: string): string {
  if (packageManager === "npm") return script === "test" ? "npm test" : `npm run ${script}`;
  if (packageManager === "yarn") return `yarn ${script}`;
  if (packageManager === "pnpm") return `pnpm ${script}`;
  if (packageManager === "bun") return `bun run ${script}`;
  return `${packageManager} run ${script}`;
}

async function packageMetadata(repositoryRoot: string): Promise<{
  packageManager: string | null;
  packageFiles: string[];
  detectedLanguages: string[];
  frameworks: string[];
  testCommands: string[];
  buildCommands: string[];
  lintCommands: string[];
}> {
  const knownPackageFiles = [
    "package.json",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "bun.lock",
    "bun.lockb",
    "pyproject.toml",
    "requirements.txt",
    "Cargo.toml",
    "go.mod",
  ];
  const packageFiles: string[] = [];
  for (const file of knownPackageFiles) {
    if (await exists(resolve(repositoryRoot, file))) packageFiles.push(file);
  }

  let packageManager: string | null = null;
  if (packageFiles.includes("pnpm-lock.yaml")) packageManager = "pnpm";
  else if (packageFiles.includes("yarn.lock")) packageManager = "yarn";
  else if (packageFiles.includes("bun.lock") || packageFiles.includes("bun.lockb")) packageManager = "bun";
  else if (packageFiles.includes("package-lock.json") || packageFiles.includes("package.json")) packageManager = "npm";

  const detectedLanguages: string[] = [];
  const frameworks: string[] = [];
  const testCommands: string[] = [];
  const buildCommands: string[] = [];
  const lintCommands: string[] = [];

  if (packageFiles.includes("package.json")) {
    detectedLanguages.push("JavaScript/TypeScript");
    frameworks.push("Node.js");
    try {
      const pkg = JSON.parse(await readFile(resolve(repositoryRoot, "package.json"), "utf8")) as {
        scripts?: Record<string, string>;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const manager = packageManager ?? "npm";
      if (pkg.scripts?.test) testCommands.push(commandForScript(manager, "test"));
      if (pkg.scripts?.build) buildCommands.push(commandForScript(manager, "build"));
      if (pkg.scripts?.lint) lintCommands.push(commandForScript(manager, "lint"));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      const frameworkNames: Array<[string, string]> = [
        ["next", "Next.js"],
        ["react", "React"],
        ["vue", "Vue"],
        ["svelte", "Svelte"],
        ["express", "Express"],
        ["@nestjs/core", "NestJS"],
        ["vitest", "Vitest"],
      ];
      for (const [dependency, label] of frameworkNames) {
        if (deps[dependency] !== undefined) frameworks.push(label);
      }
    } catch {
      // Invalid package.json is project state; do not invent metadata from it.
    }
  }
  if (packageFiles.includes("pyproject.toml") || packageFiles.includes("requirements.txt")) detectedLanguages.push("Python");
  if (packageFiles.includes("Cargo.toml")) detectedLanguages.push("Rust");
  if (packageFiles.includes("go.mod")) detectedLanguages.push("Go");

  return {
    packageManager,
    packageFiles,
    detectedLanguages: unique(detectedLanguages),
    frameworks: unique(frameworks),
    testCommands,
    buildCommands,
    lintCommands,
  };
}

async function agentsFiles(repositoryRoot: string, workingDirectory: string): Promise<string[]> {
  const rel = relative(repositoryRoot, workingDirectory);
  if (rel.startsWith("..") || resolve(repositoryRoot, rel) !== resolve(workingDirectory)) return [];
  const segments = rel === "" ? [] : rel.split(sep).filter(Boolean);
  const directories = [repositoryRoot];
  let current = repositoryRoot;
  for (const segment of segments) {
    current = resolve(current, segment);
    directories.push(current);
  }

  const result: string[] = [];
  for (const directory of directories) {
    for (const name of ["AGENTS.md", "AGENTS.override.md"]) {
      const path = resolve(directory, name);
      if (await exists(path)) result.push(path);
    }
  }
  return result;
}

export async function getProjectContext(workingDirectoryInput: string): Promise<{
  repositoryRoot: string;
  workingDirectory: string;
  currentBranch: string | null;
  defaultBranch: string | null;
  dirty: boolean;
  modifiedFiles: string[];
  untrackedFiles: string[];
  detectedLanguages: string[];
  frameworks: string[];
  packageManager: string | null;
  packageFiles: string[];
  testCommands: string[];
  buildCommands: string[];
  lintCommands: string[];
  AGENTSFiles: string[];
  gitRemote: string | null;
}> {
  const workingDirectory = await realpath(resolve(workingDirectoryInput));
  const repositoryRootRaw = (await git(workingDirectory, ["rev-parse", "--show-toplevel"], true)).trim();
  if (!repositoryRootRaw) {
    throw new LocalExecutionError("not_git_repository", `${workingDirectory} is not inside a Git repository`);
  }
  const repositoryRoot = await realpath(repositoryRootRaw);

  const [currentBranchRaw, status, remoteHead, gitRemote, metadata, discoveredAgents] = await Promise.all([
    git(repositoryRoot, ["branch", "--show-current"], true),
    git(repositoryRoot, ["status", "--porcelain=v1", "--untracked-files=all"]),
    git(repositoryRoot, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], true),
    git(repositoryRoot, ["config", "--get", "remote.origin.url"], true),
    packageMetadata(repositoryRoot),
    agentsFiles(repositoryRoot, workingDirectory),
  ]);
  const parsed = parseStatus(status);
  const normalizedRemoteHead = remoteHead.trim();
  const defaultBranch = normalizedRemoteHead.startsWith("origin/") ? normalizedRemoteHead.slice("origin/".length) : null;

  return {
    repositoryRoot,
    workingDirectory,
    currentBranch: currentBranchRaw.trim() || null,
    defaultBranch,
    ...parsed,
    ...metadata,
    AGENTSFiles: discoveredAgents,
    gitRemote: gitRemote.trim() || null,
  };
}
