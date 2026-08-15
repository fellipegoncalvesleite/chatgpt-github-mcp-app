import { spawn } from "node:child_process";
import { LocalExecutionError } from "./protocol.js";

async function psOutput(): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    let output = "";
    let errorOutput = "";
    const child = spawn("/bin/ps", ["-axo", "pid=,ppid=,user=,state=,etime=,command="], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { errorOutput += chunk.toString("utf8"); });
    child.once("error", (error) => reject(new LocalExecutionError("process_list_failed", error.message)));
    child.once("close", (code) => {
      if (code === 0) resolve(output);
      else reject(new LocalExecutionError("process_list_failed", errorOutput.trim() || `ps exited ${code}`));
    });
  });
}

export async function listLocalProcesses(filter?: string, limit = 500) {
  const text = await psOutput();
  const normalizedFilter = filter?.trim().toLowerCase();
  const processes: Array<{
    pid: number;
    ppid: number;
    user: string;
    state: string;
    elapsed: string;
    command: string;
  }> = [];

  for (const line of text.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.*)$/);
    if (!match) continue;
    const [, pidText, ppidText, user, state, elapsed, command] = match;
    if (!pidText || !ppidText || !user || !state || !elapsed || command === undefined) continue;
    if (normalizedFilter && !line.toLowerCase().includes(normalizedFilter)) continue;
    processes.push({
      pid: Number(pidText),
      ppid: Number(ppidText),
      user,
      state,
      elapsed,
      command,
    });
    if (processes.length >= Math.max(1, Math.min(limit, 2_000))) break;
  }

  return { processes, truncated: processes.length >= limit };
}

export function killLocalProcess(pid: number, signal: NodeJS.Signals = "SIGTERM") {
  if (!Number.isInteger(pid) || pid <= 0) throw new LocalExecutionError("invalid_pid", "pid must be a positive integer");
  try {
    process.kill(pid, signal);
  } catch (error) {
    throw new LocalExecutionError(
      "process_kill_failed",
      error instanceof Error ? error.message : String(error),
      { pid, signal },
    );
  }
  return { pid, signal, signaled: true };
}
