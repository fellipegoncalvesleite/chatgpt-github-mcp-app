import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dispatchLocalRequest, type LocalExecutionServices } from "../src/local/dispatcher.js";
import { TerminalManager } from "../src/local/terminal.js";

const created: string[] = [];
afterEach(async () => {
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function services(): LocalExecutionServices {
  return {
    terminal: new TerminalManager({ maxBufferBytes: 100_000, maxSessions: 4, shell: process.env.SHELL ?? "/bin/sh" }),
    maxOutputBytes: 100_000,
    maxFileBytes: 100_000,
    maxCommandTimeoutMs: 5_000,
  };
}

describe("local dispatcher", () => {
  it("reads, writes, moves, copies, searches, and deletes local files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "local-dispatcher-"));
    created.push(directory);
    const runtime = services();
    const first = join(directory, "nested", "hello.txt");

    await dispatchLocalRequest("fs.write", { path: first, content: "hello local agent", createParents: true }, runtime);
    const read = await dispatchLocalRequest("fs.read", { path: first }, runtime) as { content: string };
    expect(read.content).toBe("hello local agent");

    const copied = join(directory, "copy.txt");
    await dispatchLocalRequest("fs.copy", { source: first, destination: copied, recursive: false, overwrite: false }, runtime);
    expect(await readFile(copied, "utf8")).toBe("hello local agent");

    const moved = join(directory, "moved.txt");
    await dispatchLocalRequest("fs.move", { source: copied, destination: moved, overwrite: false }, runtime);
    const search = await dispatchLocalRequest("fs.search", { root: directory, query: "local agent", maxResults: 10 }, runtime) as { matches: unknown[] };
    expect(search.matches.length).toBeGreaterThan(0);

    await dispatchLocalRequest("fs.delete", { path: moved, recursive: false, force: false }, runtime);
    runtime.terminal.closeAll();
  });

  it("runs a shell command with cwd, environment overlay, and separated output", async () => {
    const directory = await mkdtemp(join(tmpdir(), "local-shell-"));
    created.push(directory);
    const runtime = services();
    const result = await dispatchLocalRequest("shell.run", {
      command: "printf \"$LOCAL_TEST\"; printf 'err' >&2",
      cwd: directory,
      env: { LOCAL_TEST: "ok" },
      timeoutMs: 2_000,
    }, runtime) as { stdout: string; stderr: string; exitCode: number | null; cwd: string };

    expect(result.stdout).toBe("ok");
    expect(result.stderr).toBe("err");
    expect(result.exitCode).toBe(0);
    expect(result.cwd).toBe(directory);

    const secretCheck = await dispatchLocalRequest("shell.run", {
      command: "printf \"${LOCAL_AGENT_TOKEN-unset}\"",
      env: { LOCAL_AGENT_TOKEN: "must-not-propagate" },
      timeoutMs: 2_000,
    }, runtime) as { stdout: string };
    expect(secretCheck.stdout).toBe("unset");
    runtime.terminal.closeAll();
  });

  it("keeps a terminal alive across start/send/read calls", async () => {
    const runtime = services();
    const started = await dispatchLocalRequest("terminal.start", {
      command: "read value; echo received:$value",
      cols: 120,
      rows: 40,
    }, runtime) as { sessionId: string };

    await dispatchLocalRequest("terminal.send", { sessionId: started.sessionId, input: "hello\n" }, runtime);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const read = await dispatchLocalRequest("terminal.read", { sessionId: started.sessionId, cursor: 0 }, runtime) as { output: string };
    expect(read.output).toContain("received:hello");
    await dispatchLocalRequest("terminal.stop", { sessionId: started.sessionId, signal: "SIGTERM" }, runtime);
  });

  it("returns basic host and process information", async () => {
    const runtime = services();
    const info = await dispatchLocalRequest("system.info", {}, runtime) as { homeDirectory: string; nodeVersion: string };
    expect(info.homeDirectory).toBeTruthy();
    expect(info.nodeVersion).toMatch(/^v/);
    const processes = await dispatchLocalRequest("process.list", { limit: 10 }, runtime) as { processes: unknown[] };
    expect(processes.processes.length).toBeGreaterThan(0);
    runtime.terminal.closeAll();
  });
});


describe("local development intelligence", () => {
  async function createGitFixture() {
    const directory = await mkdtemp(join(tmpdir(), "local-development-"));
    created.push(directory);
    await mkdir(join(directory, "src"), { recursive: true });
    await writeFile(join(directory, "package.json"), JSON.stringify({
      scripts: { test: "vitest run", build: "tsc -p tsconfig.json", lint: "eslint ." },
    }, null, 2));
    await writeFile(join(directory, "package-lock.json"), "{}\n");
    await writeFile(join(directory, "AGENTS.md"), "root rules\n");
    await writeFile(join(directory, "src", "AGENTS.override.md"), "src rules\n");
    await writeFile(join(directory, "src", "index.ts"), "export const createGitHubMcpServer = true;\n");
    await writeFile(join(directory, ".gitignore"), "node_modules/\n");
    execFileSync("git", ["init", "-b", "main"], { cwd: directory });
    execFileSync("git", ["config", "user.email", "tests@example.com"], { cwd: directory });
    execFileSync("git", ["config", "user.name", "Tests"], { cwd: directory });
    execFileSync("git", ["add", "."], { cwd: directory });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: directory });
    return await realpath(directory);
  }

  it("summarizes repository context conservatively from project files and Git state", async () => {
    const directory = await createGitFixture();
    await writeFile(join(directory, "src", "index.ts"), "export const createGitHubMcpServer = false;\n");
    await writeFile(join(directory, "untracked.txt"), "new\n");
    const runtime = services();

    await expect(dispatchLocalRequest("development.projectContext", {
      workingDirectory: join(directory, "src"),
    }, runtime)).resolves.toMatchObject({
      repositoryRoot: directory,
      workingDirectory: join(directory, "src"),
      currentBranch: "main",
      dirty: true,
      packageManager: "npm",
      packageFiles: expect.arrayContaining(["package.json", "package-lock.json"]),
      testCommands: ["npm test"],
      buildCommands: ["npm run build"],
      lintCommands: ["npm run lint"],
      AGENTSFiles: expect.arrayContaining([join(directory, "AGENTS.md"), join(directory, "src", "AGENTS.override.md")]),
      modifiedFiles: expect.arrayContaining(["src/index.ts"]),
      untrackedFiles: expect.arrayContaining(["untracked.txt"]),
    });
    runtime.terminal.closeAll();
  });

  it("searches source text with line numbers while ignoring dependency directories", async () => {
    const directory = await createGitFixture();
    await mkdir(join(directory, "node_modules", "ignored"), { recursive: true });
    await writeFile(join(directory, "node_modules", "ignored", "copy.ts"), "createGitHubMcpServer\n");
    const runtime = services();

    const result = await dispatchLocalRequest("development.codeSearch", {
      root: directory,
      query: "createGitHubMcpServer",
      maxResults: 10,
      contextLines: 1,
    }, runtime) as { backend: string; matches: Array<{ path: string; line: number; text: string }> };

    expect(["rg", "git-grep", "node"]).toContain(result.backend);
    expect(result.matches).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: join(directory, "src", "index.ts"), line: 1 }),
    ]));
    expect(result.matches.some((match) => match.path.includes("node_modules"))).toBe(false);
    runtime.terminal.closeAll();
  });

  it("returns structured Git review state and a bounded optional patch", async () => {
    const directory = await createGitFixture();
    await writeFile(join(directory, "src", "index.ts"), "export const createGitHubMcpServer = false;\n");
    execFileSync("git", ["add", "src/index.ts"], { cwd: directory });
    await writeFile(join(directory, "AGENTS.md"), "changed root rules\n");
    await writeFile(join(directory, "untracked.txt"), "new\n");
    const runtime = services();

    await expect(dispatchLocalRequest("development.gitReview", {
      workingDirectory: directory,
      includePatch: true,
      maxPatchBytes: 10_000,
    }, runtime)).resolves.toMatchObject({
      repositoryRoot: directory,
      branch: "main",
      headSha: expect.stringMatching(/^[0-9a-f]{40}$/),
      stagedFiles: expect.arrayContaining(["src/index.ts"]),
      unstagedFiles: expect.arrayContaining(["AGENTS.md"]),
      untrackedFiles: expect.arrayContaining(["untracked.txt"]),
      conflicts: [],
      patchTruncated: false,
      patch: expect.stringContaining("createGitHubMcpServer"),
    });
    runtime.terminal.closeAll();
  });
});


describe("local visual dispatch", () => {
  it("dispatches read-only UI context through an injected visual service", async () => {
    const runtime = {
      ...services(),
      visual: {
        async getUiContext() {
          return { frontmostApplication: "Visual Studio Code", bundleId: "com.microsoft.VSCode", windowTitle: "mcp.ts" };
        },
        async captureScreen() {
          throw new Error("not used");
        },
      },
      maxScreenshotBytes: 1_500_000,
      maxScreenshotEdge: 1600,
    } as LocalExecutionServices;

    await expect(dispatchLocalRequest("visual.uiContext", {}, runtime)).resolves.toEqual({
      frontmostApplication: "Visual Studio Code",
      bundleId: "com.microsoft.VSCode",
      windowTitle: "mcp.ts",
    });
    runtime.terminal.closeAll();
  });

  it("dispatches bounded screen capture options through the visual service", async () => {
    const calls: unknown[] = [];
    const runtime = {
      ...services(),
      visual: {
        async getUiContext() { return { frontmostApplication: null, bundleId: null, windowTitle: null }; },
        async captureScreen(options: unknown) {
          calls.push(options);
          return {
            imageBase64: Buffer.from("png").toString("base64"),
            mimeType: "image/png",
            display: "main",
            width: 1200,
            height: 800,
            byteLength: 3,
          };
        },
      },
      maxScreenshotBytes: 1_500_000,
      maxScreenshotEdge: 1600,
    } as LocalExecutionServices;

    const result = await dispatchLocalRequest("visual.captureScreen", {
      display: "main",
      includeCursor: false,
      maxEdge: 2400,
    }, runtime) as { width: number };
    expect(result.width).toBe(1200);
    expect(calls).toEqual([{ display: "main", includeCursor: false, maxEdge: 1600, maxBytes: 1_500_000 }]);
    runtime.terminal.closeAll();
  });
});
