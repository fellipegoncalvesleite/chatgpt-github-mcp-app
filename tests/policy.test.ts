import { describe, expect, it } from "vitest";
import { SecurityPolicy } from "../src/security/policy.js";
import { testConfig } from "./helpers.js";

const config = testConfig({
  protectedPathPatterns: ["**/.env", "**/*.pem"],
  maxFilesPerChange: 3,
  maxFileBytes: 100,
  maxReadFileBytes: 1000,
  maxTotalChangeBytes: 200,
});

describe("SecurityPolicy", () => {
  const policy = new SecurityPolicy(config);

  it("enforces repository allowlist", () => {
    expect(() => policy.assertRepositoryAllowed("acme/demo")).not.toThrow();
    expect(() => policy.assertRepositoryAllowed("acme/other")).toThrow(/not in/);
  });

  it("blocks protected and workflow paths", () => {
    expect(() => policy.assertPathAllowed("src/index.ts")).not.toThrow();
    expect(() => policy.assertPathAllowed(".env")).toThrow(/Protected/);
    expect(() => policy.assertPathAllowed(".github/workflows/ci.yml")).toThrow(/disabled/);
  });

  it("validates changes and rejects duplicate paths", () => {
    expect(policy.validateChanges([{ path: "src/a.ts", operation: "upsert", content: "ok" }])).toHaveLength(1);
    expect(() => policy.validateChanges([
      { path: "src/a.ts", operation: "upsert", content: "a" },
      { path: "src/a.ts", operation: "delete" },
    ])).toThrow(/Duplicate/);
  });

  it("creates a prefixed branch and blocks direct default branch writes", () => {
    expect(policy.makeBranchName("fix/login", "x")).toBe("chatgpt/fix/login");
    expect(() => policy.assertTargetBranchAllowed("main", "main")).toThrow(/disabled/);
  });
});
