import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { localChildEnvironment } from "./environment.js";
import { LocalExecutionError } from "./protocol.js";

type CapturedStream = {
  text: string;
  truncated: boolean;
};

function appendBounded(current: CapturedStream, chunk: Buffer, maxBytes: number): CapturedStream {
  if (current.truncated) return current;
  const currentBytes = Buffer.byteLength(current.text, "utf8");
  if (currentBytes >= maxBytes) return { ...current, truncated: true };
  const remaining = maxBytes - currentBytes;
  if (chunk.byteLength <= remaining) {
    return { text: current.text + chunk.toString("utf8"), truncated: false };
  }
  return {
    text: current.text + chunk.subarray(0, remaining).toString("utf8"),
    truncated: true,
  };
}

export function terminateChildTree(child: Pick<ChildProcessWithoutNullStreams, "pid" | "kill">, signal: NodeJS.Signals = "SIGTERM"): void {
  if (child.pid && process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to the direct child if no process group exists.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Process already exited.
  }
}

export async function runShell(
  command: string,
  options: {
    cwd?: string;
    env?: Record<string, string>;
    timeoutMs: number;
    maxOutputBytes: number;
    shell?: string;
  },
) {
  if (!command.trim()) throw new LocalExecutionError("invalid_command", "Command must not be empty");
  const shell = options.shell ?? process.env.SHELL ?? (process.platform === "darwin" ? "/bin/zsh" : "/bin/sh");
  const startedAt = Date.now();

  return await new Promise<{
    command: string;
    cwd: string;
    pid: number | null;
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
    stdoutTruncated: boolean;
    stderrTruncated: boolean;
    timedOut: boolean;
    durationMs: number;
  }>((resolve, reject) => {
    let stdout: CapturedStream = { text: "", truncated: false };
    let stderr: CapturedStream = { text: "", truncated: false };
    let timedOut = false;
    let settled = false;

    const child = spawn(shell, ["-lc", command], {
      cwd: options.cwd,
      env: localChildEnvironment(options.env),
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = appendBounded(stdout, chunk, options.maxOutputBytes);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = appendBounded(stderr, chunk, options.maxOutputBytes);
    });

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new LocalExecutionError("process_failed", error.message));
    });

    const timer = setTimeout(() => {
      timedOut = true;
      terminateChildTree(child, "SIGTERM");
      setTimeout(() => terminateChildTree(child, "SIGKILL"), 1_500).unref?.();
    }, options.timeoutMs);
    timer.unref?.();

    child.once("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        command,
        cwd: options.cwd ?? process.cwd(),
        pid: child.pid ?? null,
        exitCode,
        signal: signal as NodeJS.Signals | null,
        stdout: stdout.text,
        stderr: stderr.text,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
        timedOut,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}
