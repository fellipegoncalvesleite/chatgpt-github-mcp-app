import { execFile } from "node:child_process";
import { access, readFile, readdir, realpath, stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { minimatch } from "minimatch";
import { localChildEnvironment } from "./environment.js";
import { LocalExecutionError } from "./protocol.js";

const execFileAsync = promisify(execFile);
const HARD_EXCLUDED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "vendor",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  "target",
  ".venv",
  "venv",
  "__pycache__",
]);

export type CodeSearchInput = {
  root: string;
  query: string;
  globs?: string[];
  maxResults?: number;
  contextLines?: number;
  regex?: boolean;
  caseSensitive?: boolean;
};

export type CodeSearchMatch = {
  path: string;
  line: number;
  column: number;
  text: string;
  before: string[];
  after: string[];
};

async function command(executable: string, args: string[], cwd: string, maxBuffer = 5_000_000): Promise<string> {
  const { stdout } = await execFileAsync(executable, args, {
    cwd,
    env: localChildEnvironment(),
    maxBuffer,
    encoding: "utf8",
  });
  return stdout;
}

async function findRipgrep(root: string): Promise<string | null> {
  const candidates = ["/opt/homebrew/bin/rg", "/usr/local/bin/rg", "rg"];
  for (const candidate of candidates) {
    try {
      if (candidate.startsWith("/") && !(await fileExists(candidate))) continue;
      await command(candidate, ["--version"], root, 100_000);
      return candidate;
    } catch {
      // Try the next known location.
    }
  }
  return null;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function relativePosix(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

function allowedPath(root: string, path: string, globs: string[]): boolean {
  const rel = relativePosix(root, path);
  if (!rel || rel.startsWith("../")) return false;
  if (rel.split("/").some((part) => HARD_EXCLUDED_DIRECTORIES.has(part))) return false;
  if (globs.length === 0) return true;
  return globs.some((glob) => minimatch(rel, glob, { dot: true, matchBase: true }));
}

async function addContext(root: string, match: Omit<CodeSearchMatch, "before" | "after">, contextLines: number): Promise<CodeSearchMatch> {
  if (contextLines <= 0) return { ...match, before: [], after: [] };
  try {
    const text = await readFile(match.path, "utf8");
    const lines = text.split(/\r?\n/);
    const index = match.line - 1;
    return {
      ...match,
      before: lines.slice(Math.max(0, index - contextLines), index),
      after: lines.slice(index + 1, index + 1 + contextLines),
    };
  } catch {
    return { ...match, before: [], after: [] };
  }
}

async function searchWithRipgrep(executable: string, input: Required<Pick<CodeSearchInput, "root" | "query" | "globs" | "maxResults" | "contextLines" | "regex" | "caseSensitive">>): Promise<CodeSearchMatch[]> {
  const args = ["--json", "--line-number", "--column", "--hidden", "--glob", "!.git/**"];
  for (const directory of HARD_EXCLUDED_DIRECTORIES) args.push("--glob", `!${directory}/**`);
  for (const glob of input.globs) args.push("--glob", glob);
  if (!input.regex) args.push("--fixed-strings");
  if (!input.caseSensitive) args.push("--ignore-case");
  args.push("--", input.query, ".");

  let output = "";
  try {
    output = await command(executable, args, input.root);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === 1 || code === "1") return [];
    throw error;
  }

  const matches: CodeSearchMatch[] = [];
  for (const line of output.split("\n")) {
    if (!line || matches.length >= input.maxResults) continue;
    let event: {
      type?: string;
      data?: {
        path?: { text?: string };
        lines?: { text?: string };
        line_number?: number;
        submatches?: Array<{ start?: number }>;
      };
    };
    try {
      event = JSON.parse(line) as typeof event;
    } catch {
      continue;
    }
    if (event.type !== "match") continue;
    const rel = event.data?.path?.text;
    const lineNumber = event.data?.line_number;
    if (!rel || typeof lineNumber !== "number") continue;
    const path = resolve(input.root, rel);
    if (!allowedPath(input.root, path, input.globs)) continue;
    const rawText = event.data?.lines?.text ?? "";
    const column = (event.data?.submatches?.[0]?.start ?? 0) + 1;
    matches.push(await addContext(input.root, {
      path,
      line: lineNumber,
      column,
      text: rawText.replace(/\r?\n$/, ""),
    }, input.contextLines));
  }
  return matches;
}

async function gitListedFiles(root: string): Promise<string[] | null> {
  try {
    const repositoryRoot = (await command("git", ["rev-parse", "--show-toplevel"], root, 100_000)).trim();
    if (!repositoryRoot) return null;
    const output = await command("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], repositoryRoot, 10_000_000);
    return output.split("\0").filter(Boolean).map((path) => resolve(repositoryRoot, path)).filter((path) => {
      const rel = relative(root, path);
      return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== "..";
    });
  } catch {
    return null;
  }
}

async function recursivelyListedFiles(root: string, limit = 50_000): Promise<string[]> {
  const files: string[] = [];
  const stack = [root];
  while (stack.length > 0 && files.length < limit) {
    const directory = stack.pop()!;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (files.length >= limit) break;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        if (!HARD_EXCLUDED_DIRECTORIES.has(entry.name)) stack.push(path);
      } else if (entry.isFile()) {
        files.push(path);
      }
    }
  }
  return files;
}

async function searchWithNode(input: Required<Pick<CodeSearchInput, "root" | "query" | "globs" | "maxResults" | "contextLines" | "regex" | "caseSensitive">>): Promise<CodeSearchMatch[]> {
  const listed = await gitListedFiles(input.root) ?? await recursivelyListedFiles(input.root);
  let matcher: RegExp | null = null;
  if (input.regex) {
    try {
      matcher = new RegExp(input.query, input.caseSensitive ? "u" : "iu");
    } catch (error) {
      throw new LocalExecutionError("invalid_search_pattern", error instanceof Error ? error.message : String(error));
    }
  }
  const needle = input.caseSensitive ? input.query : input.query.toLocaleLowerCase();
  const matches: CodeSearchMatch[] = [];

  for (const path of listed) {
    if (matches.length >= input.maxResults || !allowedPath(input.root, path, input.globs)) continue;
    let info;
    try {
      info = await stat(path);
    } catch {
      continue;
    }
    if (!info.isFile() || info.size > 1_000_000) continue;
    let buffer: Buffer;
    try {
      buffer = await readFile(path);
    } catch {
      continue;
    }
    if (buffer.includes(0)) continue;
    const lines = buffer.toString("utf8").split(/\r?\n/);
    for (let index = 0; index < lines.length && matches.length < input.maxResults; index += 1) {
      const text = lines[index] ?? "";
      let column = -1;
      if (matcher) {
        const result = matcher.exec(text);
        column = result?.index ?? -1;
      } else {
        const haystack = input.caseSensitive ? text : text.toLocaleLowerCase();
        column = haystack.indexOf(needle);
      }
      if (column < 0) continue;
      matches.push({
        path,
        line: index + 1,
        column: column + 1,
        text,
        before: lines.slice(Math.max(0, index - input.contextLines), index),
        after: lines.slice(index + 1, index + 1 + input.contextLines),
      });
    }
  }
  return matches;
}

export async function searchCode(raw: CodeSearchInput): Promise<{
  root: string;
  query: string;
  backend: "rg" | "node";
  matches: CodeSearchMatch[];
  truncated: boolean;
}> {
  const root = await realpath(resolve(raw.root));
  const query = raw.query.trim();
  if (!query) throw new LocalExecutionError("invalid_search_query", "Search query must not be empty");
  const input = {
    root,
    query,
    globs: raw.globs ?? [],
    maxResults: Math.max(1, Math.min(raw.maxResults ?? 50, 500)),
    contextLines: Math.max(0, Math.min(raw.contextLines ?? 1, 5)),
    regex: raw.regex ?? false,
    caseSensitive: raw.caseSensitive ?? true,
  };
  const ripgrep = await findRipgrep(root);
  const backend = ripgrep ? "rg" as const : "node" as const;
  const matches = ripgrep
    ? await searchWithRipgrep(ripgrep, input)
    : await searchWithNode(input);
  return {
    root,
    query,
    backend,
    matches,
    truncated: matches.length >= input.maxResults,
  };
}
