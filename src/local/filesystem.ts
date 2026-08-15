import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { LocalExecutionError } from "./protocol.js";

function localPath(input: string): string {
  if (!input.trim()) throw new LocalExecutionError("invalid_local_path", "Path must not be empty");
  return resolve(input);
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function entryType(entry: { isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }): string {
  if (entry.isDirectory()) return "directory";
  if (entry.isFile()) return "file";
  if (entry.isSymbolicLink()) return "symlink";
  return "other";
}

export async function listLocalDirectory(input: string, maxEntries = 5_000) {
  const path = localPath(input);
  const entries = await readdir(path, { withFileTypes: true });
  const selected = entries.slice(0, Math.max(1, maxEntries));
  const detailed = await Promise.all(selected.map(async (entry) => {
    const fullPath = resolve(path, entry.name);
    try {
      const info = await lstat(fullPath);
      return {
        name: entry.name,
        path: fullPath,
        type: entryType(entry),
        size: info.size,
        mtimeMs: info.mtimeMs,
        mode: info.mode,
      };
    } catch {
      return {
        name: entry.name,
        path: fullPath,
        type: entryType(entry),
        size: null,
        mtimeMs: null,
        mode: null,
      };
    }
  }));
  return { path, entries: detailed, truncated: entries.length > detailed.length };
}

export async function readLocalTextFile(input: string, maxBytes: number) {
  const path = localPath(input);
  const info = await stat(path);
  if (!info.isFile()) throw new LocalExecutionError("invalid_local_path", `${path} is not a regular file`);
  if (info.size > maxBytes) {
    throw new LocalExecutionError("file_too_large", `${path} exceeds the local file-read limit`, {
      size: info.size,
      maxBytes,
    });
  }
  const content = await readFile(path, "utf8");
  return { path, size: info.size, content };
}

export async function writeLocalTextFile(
  input: string,
  content: string,
  options: { createParents: boolean; maxBytes: number },
) {
  const path = localPath(input);
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > options.maxBytes) {
    throw new LocalExecutionError("file_too_large", `${path} exceeds the local file-write limit`, {
      size: bytes,
      maxBytes: options.maxBytes,
    });
  }
  if (options.createParents) await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, { encoding: "utf8" });
  return { path, bytes };
}

export async function moveLocalPath(sourceInput: string, destinationInput: string, overwrite: boolean) {
  const source = localPath(sourceInput);
  const destination = localPath(destinationInput);
  if (source === destination) return { source, destination };
  if (!overwrite && await exists(destination)) {
    throw new LocalExecutionError("destination_exists", `Destination already exists: ${destination}`);
  }
  if (overwrite && await exists(destination)) await rm(destination, { recursive: true, force: true });
  await mkdir(dirname(destination), { recursive: true });
  try {
    await rename(source, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    const sourceInfo = await lstat(source);
    await cp(source, destination, { recursive: sourceInfo.isDirectory(), force: overwrite, errorOnExist: !overwrite });
    await rm(source, { recursive: sourceInfo.isDirectory(), force: false });
  }
  return { source, destination };
}

export async function copyLocalPath(
  sourceInput: string,
  destinationInput: string,
  recursive: boolean,
  overwrite: boolean,
) {
  const source = localPath(sourceInput);
  const destination = localPath(destinationInput);
  if (source === destination) return { source, destination };
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, { recursive, force: overwrite, errorOnExist: !overwrite });
  return { source, destination };
}

export async function deleteLocalPath(input: string, recursive: boolean, force: boolean) {
  const path = localPath(input);
  await rm(path, { recursive, force });
  return { path, deleted: true };
}

export async function searchLocalFiles(
  rootInput: string,
  queryInput: string,
  options: { maxResults: number; maxVisited?: number; maxContentBytes?: number },
) {
  const root = localPath(rootInput);
  const query = queryInput.trim().toLowerCase();
  if (!query) throw new LocalExecutionError("invalid_search_query", "Search query must not be empty");

  const maxResults = Math.max(1, Math.min(options.maxResults, 500));
  const maxVisited = Math.max(maxResults, options.maxVisited ?? 50_000);
  const maxContentBytes = Math.max(1, options.maxContentBytes ?? 256_000);
  const stack = [root];
  const matches: Array<{ path: string; match: "path" | "content"; line?: number }> = [];
  let visited = 0;

  while (stack.length > 0 && matches.length < maxResults && visited < maxVisited) {
    const current = stack.pop()!;
    let info;
    try {
      info = await lstat(current);
    } catch {
      continue;
    }
    visited += 1;

    if (current.toLowerCase().includes(query)) {
      matches.push({ path: current, match: "path" });
      if (matches.length >= maxResults) break;
    }

    if (info.isSymbolicLink()) continue;

    if (info.isDirectory()) {
      let children;
      try {
        children = await readdir(current);
      } catch {
        continue;
      }
      for (let index = children.length - 1; index >= 0; index -= 1) {
        const child = children[index];
        if (child !== undefined) stack.push(resolve(current, child));
      }
      continue;
    }

    if (!info.isFile() || info.size > maxContentBytes) continue;

    try {
      const buffer = await readFile(current);
      if (buffer.includes(0)) continue;
      const text = buffer.toString("utf8");
      const lower = text.toLowerCase();
      const index = lower.indexOf(query);
      if (index >= 0) {
        const line = text.slice(0, index).split("\n").length;
        matches.push({ path: current, match: "content", line });
      }
    } catch {
      // Ignore files the current macOS user cannot read.
    }
  }

  return {
    root,
    query: queryInput,
    matches,
    visited,
    truncated: matches.length >= maxResults || visited >= maxVisited || stack.length > 0,
  };
}
