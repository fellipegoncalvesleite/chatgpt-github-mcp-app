import { mkdtemp, readFile, rm } from "node:fs/promises";
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
