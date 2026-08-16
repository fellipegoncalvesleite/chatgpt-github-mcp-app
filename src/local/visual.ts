import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { localChildEnvironment } from "./environment.js";
import { LocalExecutionError } from "./protocol.js";

const execFileAsync = promisify(execFile);

export type UiContext = {
  frontmostApplication: string | null;
  bundleId: string | null;
  windowTitle: string | null;
};

export type ScreenDisplay = "main" | number;

export type ScreenCaptureOptions = {
  display: ScreenDisplay;
  includeCursor: boolean;
  maxEdge: number;
  maxBytes: number;
};

export type ScreenCapture = {
  imageBase64: string;
  mimeType: "image/png";
  display: ScreenDisplay;
  width: number;
  height: number;
  byteLength: number;
};

export interface LocalVisualService {
  getUiContext(): Promise<UiContext>;
  captureScreen(options: ScreenCaptureOptions): Promise<ScreenCapture>;
}

type CommandResult = { stdout: string; stderr: string };
export type VisualCommandRunner = (executable: string, args: string[]) => Promise<CommandResult>;

async function defaultCommandRunner(executable: string, args: string[]): Promise<CommandResult> {
  const result = await execFileAsync(executable, args, {
    env: localChildEnvironment(),
    encoding: "utf8",
    maxBuffer: 5_000_000,
  });
  return { stdout: result.stdout, stderr: result.stderr };
}

function unquote(value: string | undefined): string | null {
  if (!value) return null;
  return value.replace(/^"|"$/g, "").replaceAll('\\"', '"').replaceAll("\\\\", "\\");
}

function parseLsAppInfo(output: string): Pick<UiContext, "frontmostApplication" | "bundleId"> {
  const name = output.match(/"LSDisplayName"=("(?:\\.|[^"])*")/)?.[1];
  const bundleId = output.match(/"CFBundleIdentifier"=("(?:\\.|[^"])*")/)?.[1];
  return {
    frontmostApplication: unquote(name),
    bundleId: unquote(bundleId),
  };
}

function commandErrorText(error: unknown): string {
  if (typeof error !== "object" || error === null) return String(error);
  const record = error as Record<string, unknown>;
  return [record.message, record.stderr, record.stdout]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join("\n");
}

function parseDimensions(output: string): { width: number; height: number } {
  const width = Number.parseInt(output.match(/pixelWidth:\s*(\d+)/)?.[1] ?? "", 10);
  const height = Number.parseInt(output.match(/pixelHeight:\s*(\d+)/)?.[1] ?? "", 10);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new LocalExecutionError("screenshot_metadata_unavailable", "Could not determine captured screenshot dimensions");
  }
  return { width, height };
}

export class MacVisualService implements LocalVisualService {
  constructor(
    private readonly options: {
      platform?: NodeJS.Platform;
      runCommand?: VisualCommandRunner;
      makeTempDirectory?: () => Promise<string>;
    } = {},
  ) {}

  private get platform(): NodeJS.Platform {
    return this.options.platform ?? process.platform;
  }

  private get runCommand(): VisualCommandRunner {
    return this.options.runCommand ?? defaultCommandRunner;
  }

  private ensureMac(): void {
    if (this.platform !== "darwin") {
      throw new LocalExecutionError("unsupported_platform", "Visual inspection is currently supported only on macOS");
    }
  }

  async getUiContext(): Promise<UiContext> {
    this.ensureMac();
    const front = (await this.runCommand("/usr/bin/lsappinfo", ["front"])).stdout.trim();
    if (!front) return { frontmostApplication: null, bundleId: null, windowTitle: null };
    const info = await this.runCommand("/usr/bin/lsappinfo", ["info", "-only", "name", "-only", "bundleid", front]);
    let windowTitle: string | null = null;
    try {
      const title = await this.runCommand("/usr/bin/osascript", [
        "-e",
        'tell application "System Events" to tell (first application process whose frontmost is true) to if (count of windows) > 0 then return name of front window',
      ]);
      windowTitle = title.stdout.trim() || null;
    } catch {
      // Window title is best-effort. Never escalate permissions or activate/focus an application.
    }
    return { ...parseLsAppInfo(info.stdout), windowTitle };
  }

  private async dimensions(path: string): Promise<{ width: number; height: number }> {
    const result = await this.runCommand("/usr/bin/sips", ["-g", "pixelWidth", "-g", "pixelHeight", path]);
    return parseDimensions(result.stdout);
  }

  private async resize(path: string, maxEdge: number): Promise<void> {
    await this.runCommand("/usr/bin/sips", ["-Z", String(maxEdge), path]);
  }

  async captureScreen(options: ScreenCaptureOptions): Promise<ScreenCapture> {
    this.ensureMac();
    const makeTempDirectory = this.options.makeTempDirectory ?? (() => mkdtemp(join(tmpdir(), "chatgpt-screen-")));
    const directory = await makeTempDirectory();
    const path = join(directory, "screen.png");
    try {
      const args = ["-x", "-t", "png"];
      if (options.includeCursor) args.push("-C");
      if (options.display === "main") args.push("-m");
      else args.push(`-D${options.display}`);
      args.push(path);

      try {
        await this.runCommand("/usr/sbin/screencapture", args);
      } catch (error) {
        const detail = commandErrorText(error);
        if (/could not create image|screen recording|not authorized|permission/i.test(detail)) {
          throw new LocalExecutionError(
            "screen_recording_permission_required",
            "macOS Screen Recording permission is required for one-shot screenshot capture. Grant it in System Settings; the bridge will not attempt to bypass macOS permissions.",
          );
        }
        throw error;
      }

      let dimensions: { width: number; height: number };
      try {
        dimensions = await this.dimensions(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new LocalExecutionError(
            "screen_recording_permission_required",
            "macOS did not produce a screenshot. Screen Recording permission may be required; the bridge will not attempt to bypass macOS permissions.",
          );
        }
        throw error;
      }

      if (Math.max(dimensions.width, dimensions.height) > options.maxEdge) {
        await this.resize(path, options.maxEdge);
        dimensions = await this.dimensions(path);
      }

      let info = await stat(path);
      let attempts = 0;
      let currentMaxEdge = Math.max(dimensions.width, dimensions.height);
      while (info.size > options.maxBytes && attempts < 4 && currentMaxEdge > 256) {
        const ratio = Math.sqrt(options.maxBytes / info.size) * 0.9;
        const nextMaxEdge = Math.max(256, Math.min(currentMaxEdge - 1, Math.floor(currentMaxEdge * ratio)));
        if (nextMaxEdge >= currentMaxEdge) break;
        await this.resize(path, nextMaxEdge);
        dimensions = await this.dimensions(path);
        info = await stat(path);
        currentMaxEdge = Math.max(dimensions.width, dimensions.height);
        attempts += 1;
      }

      if (info.size > options.maxBytes) {
        throw new LocalExecutionError("screenshot_too_large", "Screenshot remains above the configured hard byte limit after bounded resizing", {
          byteLength: info.size,
          maxBytes: options.maxBytes,
        });
      }

      const image = await readFile(path);
      return {
        imageBase64: image.toString("base64"),
        mimeType: "image/png",
        display: options.display,
        width: dimensions.width,
        height: dimensions.height,
        byteLength: info.size,
      };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
