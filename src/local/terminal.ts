import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { localChildEnvironment } from "./environment.js";
import { LocalExecutionError } from "./protocol.js";
import { terminateChildTree } from "./shell.js";

type TerminalSession = {
  id: string;
  child: ChildProcessWithoutNullStreams;
  output: string;
  baseCursor: number;
  nextCursor: number;
  exited: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  startedAt: number;
};

export class TerminalManager {
  private readonly sessions = new Map<string, TerminalSession>();

  constructor(
    private readonly options: {
      maxBufferBytes: number;
      maxSessions: number;
      shell?: string;
    },
  ) {}

  start(input: {
    command?: string;
    cwd?: string;
    cols?: number;
    rows?: number;
    env?: Record<string, string>;
  }) {
    const activeSessions = [...this.sessions.values()].filter((session) => !session.exited).length;
    if (activeSessions >= this.options.maxSessions) {
      throw new LocalExecutionError("too_many_sessions", `At most ${this.options.maxSessions} terminal sessions may be active`);
    }

    const shell = this.options.shell ?? process.env.SHELL ?? (process.platform === "darwin" ? "/bin/zsh" : "/bin/sh");
    const command = input.command?.trim();
    const spawnSpec = this.spawnSpec(shell, command);
    const child = spawn(spawnSpec.executable, spawnSpec.args, {
      cwd: input.cwd,
      env: {
        ...localChildEnvironment(input.env),
        TERM: process.env.TERM ?? "xterm-256color",
        COLUMNS: String(input.cols ?? 120),
        LINES: String(input.rows ?? 40),
      },
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });

    const session: TerminalSession = {
      id: randomUUID(),
      child,
      output: "",
      baseCursor: 0,
      nextCursor: 0,
      exited: false,
      exitCode: null,
      signal: null,
      startedAt: Date.now(),
    };
    this.sessions.set(session.id, session);

    const append = (chunk: Buffer) => this.append(session, chunk.toString("utf8"));
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.once("error", (error) => this.append(session, `\n[terminal error: ${error.message}]\n`));
    child.once("close", (exitCode, signal) => {
      session.exited = true;
      session.exitCode = exitCode;
      session.signal = signal as NodeJS.Signals | null;
      const cleanup = setTimeout(() => {
        if (this.sessions.get(session.id)?.exited) this.sessions.delete(session.id);
      }, 10 * 60_000);
      cleanup.unref?.();
    });

    return {
      sessionId: session.id,
      pid: child.pid ?? null,
      command: command ?? shell,
      cwd: input.cwd ?? process.cwd(),
      pty: process.platform === "darwin" ? "script" : "pipe",
    };
  }

  read(sessionId: string, cursor = 0) {
    const session = this.require(sessionId);
    const requestedCursor = Math.max(0, Math.floor(cursor));
    const effectiveCursor = Math.max(requestedCursor, session.baseCursor);
    const start = Math.max(0, effectiveCursor - session.baseCursor);
    return {
      sessionId,
      output: session.output.slice(start),
      cursor: effectiveCursor,
      nextCursor: session.nextCursor,
      truncated: requestedCursor < session.baseCursor,
      running: !session.exited,
      exitCode: session.exitCode,
      signal: session.signal,
      pid: session.child.pid ?? null,
    };
  }

  send(sessionId: string, input: string) {
    const session = this.require(sessionId);
    if (session.exited || session.child.stdin.destroyed) {
      throw new LocalExecutionError("session_not_running", `Terminal session ${sessionId} is not running`);
    }
    session.child.stdin.write(input);
    return { sessionId, bytes: Buffer.byteLength(input, "utf8") };
  }

  resize(sessionId: string, cols: number, rows: number) {
    const session = this.require(sessionId);
    if (!session.exited && session.child.pid) {
      try {
        process.kill(session.child.pid, "SIGWINCH");
      } catch {
        // Resize notification is best-effort with the native script wrapper.
      }
    }
    return {
      sessionId,
      cols,
      rows,
      resized: false,
      note: "The dependency-free v1 terminal uses macOS script(1); input/output is PTY-backed on macOS, but window-size ioctl is not exposed.",
    };
  }

  stop(sessionId: string, signal: NodeJS.Signals = "SIGTERM") {
    const session = this.require(sessionId);
    if (!session.exited) terminateChildTree(session.child, signal);
    this.sessions.delete(sessionId);
    return { sessionId, stopped: true, signal };
  }

  closeAll(): void {
    for (const session of this.sessions.values()) {
      if (!session.exited) terminateChildTree(session.child, "SIGTERM");
    }
    this.sessions.clear();
  }

  private require(sessionId: string): TerminalSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new LocalExecutionError("session_not_found", `Terminal session ${sessionId} does not exist`);
    return session;
  }

  private append(session: TerminalSession, text: string): void {
    session.output += text;
    session.nextCursor += text.length;
    const maxChars = Math.max(1, this.options.maxBufferBytes);
    if (session.output.length > maxChars) {
      const remove = session.output.length - maxChars;
      session.output = session.output.slice(remove);
      session.baseCursor += remove;
    }
  }

  private spawnSpec(shell: string, command: string | undefined): { executable: string; args: string[] } {
    if (process.platform === "darwin") {
      const args = ["-q", "/dev/null", shell];
      if (command) args.push("-lc", command);
      else args.push("-il");
      return { executable: "/usr/bin/script", args };
    }
    return {
      executable: shell,
      args: command ? ["-lc", command] : ["-il"],
    };
  }
}
