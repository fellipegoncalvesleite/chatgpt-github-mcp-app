import { access, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MacVisualService, type VisualCommandRunner } from "../src/local/visual.js";

describe("Mac visual service", () => {
  it("resizes screenshots to the configured edge and byte limits and deletes temporary files", async () => {
    let dimensions = { width: 2400, height: 1600 };
    let tempDirectory = "";
    let screenshotPath = "";
    const runner: VisualCommandRunner = async (executable, args) => {
      if (executable === "/usr/sbin/screencapture") {
        screenshotPath = args.at(-1)!;
        await writeFile(screenshotPath, Buffer.alloc(2_000_000, 1));
        return { stdout: "", stderr: "" };
      }
      if (executable === "/usr/bin/sips" && args.includes("-Z")) {
        dimensions = { width: 1500, height: 1000 };
        await writeFile(screenshotPath, Buffer.alloc(50_000, 2));
        return { stdout: "", stderr: "" };
      }
      if (executable === "/usr/bin/sips") {
        return {
          stdout: `pixelWidth: ${dimensions.width}\npixelHeight: ${dimensions.height}\n`,
          stderr: "",
        };
      }
      throw new Error(`Unexpected command: ${executable} ${args.join(" ")}`);
    };
    const service = new MacVisualService({
      platform: "darwin",
      runCommand: runner,
      async makeTempDirectory() {
        tempDirectory = await mkdtemp(join(tmpdir(), "visual-test-"));
        return tempDirectory;
      },
    });

    const result = await service.captureScreen({
      display: "main",
      includeCursor: false,
      maxEdge: 1600,
      maxBytes: 1_500_000,
    });

    expect(result).toMatchObject({
      mimeType: "image/png",
      display: "main",
      width: 1500,
      height: 1000,
      byteLength: 50_000,
    });
    expect(Buffer.from(result.imageBase64, "base64")).toHaveLength(50_000);
    await expect(access(tempDirectory)).rejects.toThrow();
  });

  it("maps macOS Screen Recording denial to a useful permission error and cleans up", async () => {
    let tempDirectory = "";
    const service = new MacVisualService({
      platform: "darwin",
      async runCommand(executable) {
        if (executable === "/usr/sbin/screencapture") {
          const error = Object.assign(new Error("capture failed"), {
            stderr: "could not create image from display 1",
          });
          throw error;
        }
        throw new Error(`Unexpected command: ${executable}`);
      },
      async makeTempDirectory() {
        tempDirectory = await mkdtemp(join(tmpdir(), "visual-permission-test-"));
        return tempDirectory;
      },
    });

    await expect(service.captureScreen({
      display: "main",
      includeCursor: false,
      maxEdge: 1600,
      maxBytes: 1_500_000,
    })).rejects.toMatchObject({ code: "screen_recording_permission_required" });
    await expect(access(tempDirectory)).rejects.toThrow();
  });

  it("refuses visual capture on unsupported platforms", async () => {
    const service = new MacVisualService({ platform: "linux" });
    await expect(service.captureScreen({
      display: "main",
      includeCursor: false,
      maxEdge: 1600,
      maxBytes: 1_500_000,
    })).rejects.toMatchObject({ code: "unsupported_platform" });
  });
});

describe("Mac UI context", () => {
  it("returns frontmost app metadata and a best-effort front window title without activating the app", async () => {
    const calls: Array<{ executable: string; args: string[] }> = [];
    const service = new MacVisualService({
      platform: "darwin",
      async runCommand(executable, args) {
        calls.push({ executable, args });
        if (executable === "/usr/bin/lsappinfo" && args[0] === "front") {
          return { stdout: "ASN:0x0-0x123:\n", stderr: "" };
        }
        if (executable === "/usr/bin/lsappinfo") {
          return {
            stdout: '"LSDisplayName"="Visual Studio Code"\n"CFBundleIdentifier"="com.microsoft.VSCode"\n',
            stderr: "",
          };
        }
        if (executable === "/usr/bin/osascript") {
          return { stdout: "mcp.ts — chatgpt-github-mcp-app\n", stderr: "" };
        }
        throw new Error(`Unexpected command: ${executable}`);
      },
    });

    await expect(service.getUiContext()).resolves.toEqual({
      frontmostApplication: "Visual Studio Code",
      bundleId: "com.microsoft.VSCode",
      windowTitle: "mcp.ts — chatgpt-github-mcp-app",
    });
    expect(calls.some((call) => call.executable === "/usr/bin/osascript")).toBe(true);
    expect(JSON.stringify(calls)).not.toMatch(/activate|open|frontmost.*true.*set/i);
  });
});
