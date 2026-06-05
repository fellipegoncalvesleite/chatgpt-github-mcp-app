import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export type AuditEvent = {
  timestamp?: string;
  actor?: string;
  clientId?: string;
  tool: string;
  repository?: string;
  branch?: string;
  paths?: string[];
  outcome: "success" | "denied" | "error";
  details?: Record<string, unknown>;
};

export class AuditLogger {
  constructor(private readonly path: string) {}

  async write(event: AuditEvent): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const safeEvent = {
      ...event,
      timestamp: event.timestamp ?? new Date().toISOString(),
    };
    await appendFile(this.path, `${JSON.stringify(safeEvent)}\n`, { encoding: "utf8", mode: 0o600 });
  }
}
