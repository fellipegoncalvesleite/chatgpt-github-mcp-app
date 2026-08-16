import { execFile, spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { localChildEnvironment } from "./environment.js";
import { LocalExecutionError } from "./protocol.js";

const execFileAsync = promisify(execFile);
const CONFLICT_CODES = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

async function git(cwd: string, args: string[], allowFailure = false, maxBuffer = 5_000_000): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      env: localChildEnvironment(),
      maxBuffer,
      encoding: "utf8",
    });
    return stdout;
  } catch (error) {
    if (allowFailure) return "";
    throw new LocalExecutionError("git_command_failed", error instanceof Error ? error.message : String(error));
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function parseStatus(status: string): {
  stagedFiles: string[];
  unstagedFiles: string[];
  untrackedFiles: string[];
  conflicts: string[];
} {
  const stagedFiles: string[] = [];
  const unstagedFiles: string[] = [];
  const untrackedFiles: string[] = [];
  const conflicts: string[] = [];
  for (const line of status.split("\n")) {
    if (!line) continue;
    const code = line.slice(0, 2);
    const rawPath = line.slice(3).trim();
    const path = rawPath.includes(" -> ") ? rawPath.split(" -> ").at(-1)! : rawPath;
    if (code === "??") {
      untrackedFiles.push(path);
      continue;
    }
    if (CONFLICT_CODES.has(code)) conflicts.push(path);
    if (code[0] && code[0] !== " " && code[0] !== "?") stagedFiles.push(path);
    if (code[1] && code[1] !== " " && code[1] !== "?") unstagedFiles.push(path);
  }
  return {
    stagedFiles: unique(stagedFiles),
    unstagedFiles: unique(unstagedFiles),
    untrackedFiles: unique(untrackedFiles),
    conflicts: unique(conflicts),
  };
}

function utf8Prefix(buffer: Buffer, maxBytes: number): string {
  let end = Math.min(buffer.length, maxBytes);
  if (end === buffer.length || end === 0) return buffer.subarray(0, end).toString("utf8");

  let start = end - 1;
  while (start > 0 && (buffer[start]! & 0b1100_0000) === 0b1000_0000) start -= 1;
  const first = buffer[start]!;
  const expectedLength = first <= 0x7f ? 1 : first <= 0xdf ? 2 : first <= 0xef ? 3 : 4;
  if (end - start < expectedLength) end = start;
  return buffer.subarray(0, end).toString("utf8");
}

async function boundedGitPatch(cwd: string, maxBytes: number): Promise<{ value: string; truncated: boolean }> {
  return await new Promise((resolvePatch, rejectPatch) => {
    const child = spawn("git", ["diff", "HEAD", "--no-ext-diff", "--no-color", "--no-textconv"], {
      cwd,
      env: localChildEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let collectedBytes = 0;
    let totalBytes = 0;
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      totalBytes += chunk.length;
      const remaining = maxBytes + 4 - collectedBytes;
      if (remaining > 0) {
        const piece = chunk.subarray(0, Math.min(remaining, chunk.length));
        chunks.push(piece);
        collectedBytes += piece.length;
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 64_000) stderr += chunk.toString("utf8").slice(0, 64_000 - stderr.length);
    });
    child.on("error", (error) => {
      rejectPatch(new LocalExecutionError("git_command_failed", error.message));
    });
    child.on("close", (code) => {
      if (code !== 0) {
        rejectPatch(new LocalExecutionError("git_command_failed", stderr.trim() || `git diff exited with code ${code}`));
        return;
      }
      const buffer = Buffer.concat(chunks);
      resolvePatch({
        value: utf8Prefix(buffer, maxBytes),
        truncated: totalBytes > maxBytes,
      });
    });
  });
}

export async function reviewGit(input: {
  workingDirectory: string;
  includePatch?: boolean;
  maxPatchBytes?: number;
}): Promise<{
  repositoryRoot: string;
  branch: string | null;
  headSha: string;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  stagedFiles: string[];
  unstagedFiles: string[];
  untrackedFiles: string[];
  conflicts: string[];
  diffStat: string;
  patch?: string;
  patchTruncated?: boolean;
}> {
  const workingDirectory = await realpath(resolve(input.workingDirectory));
  const repositoryRootRaw = (await git(workingDirectory, ["rev-parse", "--show-toplevel"], true)).trim();
  if (!repositoryRootRaw) throw new LocalExecutionError("not_git_repository", `${workingDirectory} is not inside a Git repository`);
  const repositoryRoot = await realpath(repositoryRootRaw);

  const [branchRaw, headShaRaw, upstreamRaw, status, diffStat] = await Promise.all([
    git(repositoryRoot, ["branch", "--show-current"], true),
    git(repositoryRoot, ["rev-parse", "HEAD"]),
    git(repositoryRoot, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], true),
    git(repositoryRoot, ["status", "--porcelain=v1", "--untracked-files=all"]),
    git(repositoryRoot, ["diff", "--stat", "HEAD", "--no-ext-diff", "--no-color"], true),
  ]);
  const parsed = parseStatus(status);
  const upstream = upstreamRaw.trim() || null;
  let ahead: number | null = null;
  let behind: number | null = null;
  if (upstream) {
    const counts = (await git(repositoryRoot, ["rev-list", "--left-right", "--count", `HEAD...${upstream}`], true)).trim();
    const [aheadRaw, behindRaw] = counts.split(/\s+/);
    if (aheadRaw !== undefined && behindRaw !== undefined) {
      const parsedAhead = Number.parseInt(aheadRaw, 10);
      const parsedBehind = Number.parseInt(behindRaw, 10);
      if (Number.isFinite(parsedAhead) && Number.isFinite(parsedBehind)) {
        ahead = parsedAhead;
        behind = parsedBehind;
      }
    }
  }

  const result: {
    repositoryRoot: string;
    branch: string | null;
    headSha: string;
    upstream: string | null;
    ahead: number | null;
    behind: number | null;
    stagedFiles: string[];
    unstagedFiles: string[];
    untrackedFiles: string[];
    conflicts: string[];
    diffStat: string;
    patch?: string;
    patchTruncated?: boolean;
  } = {
    repositoryRoot,
    branch: branchRaw.trim() || null,
    headSha: headShaRaw.trim(),
    upstream,
    ahead,
    behind,
    ...parsed,
    diffStat: diffStat.trim(),
  };

  if (input.includePatch) {
    const maxPatchBytes = Math.max(1_000, Math.min(input.maxPatchBytes ?? 200_000, 2_000_000));
    const bounded = await boundedGitPatch(repositoryRoot, maxPatchBytes);
    result.patch = bounded.value;
    result.patchTruncated = bounded.truncated;
  }

  return result;
}
