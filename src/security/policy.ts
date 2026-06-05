import { minimatch } from "minimatch";
import type { AppConfig } from "../config.js";
import { AppError } from "../errors.js";
import { isLikelyBinary, normalizePath, normalizeRepo, sanitizeBranchSegment } from "../utils.js";

export type FileChange =
  | { path: string; operation: "upsert"; content: string }
  | { path: string; operation: "delete" };

export class SecurityPolicy {
  constructor(private readonly config: AppConfig) {}

  assertRepositoryAllowed(repository: string): void {
    const normalized = normalizeRepo(repository);
    if (this.config.allowAllInstalledRepos) return;
    if (!this.config.allowedRepositories.includes(normalized)) {
      throw new AppError("repository_not_allowed", `Repository ${repository} is not in GITHUB_ALLOWED_REPOSITORIES`, 403);
    }
  }

  assertReadablePath(input: string): string {
    const path = normalizePath(input);
    const publicEnvironmentTemplate = /(^|\/)\.env\.(example|sample|template)$/i.test(path);
    if (!publicEnvironmentTemplate && this.config.protectedPathPatterns.some((pattern) => minimatch(path, pattern, { dot: true, nocase: true }))) {
      throw new AppError("protected_path", `Protected path cannot be read or modified: ${path}`, 403);
    }
    return path;
  }

  assertWritablePath(input: string): string {
    const path = this.assertReadablePath(input);
    if (!this.config.allowWorkflowEdits && (path === ".github/workflows" || path.startsWith(".github/workflows/"))) {
      throw new AppError("workflow_edits_disabled", `Workflow edits are disabled: ${path}`, 403);
    }
    return path;
  }

  /** @deprecated Prefer assertReadablePath or assertWritablePath. */
  assertPathAllowed(input: string): string {
    return this.assertWritablePath(input);
  }

  validateChanges(changes: FileChange[]): FileChange[] {
    if (changes.length === 0) throw new AppError("empty_change", "At least one file change is required");
    if (changes.length > this.config.maxFilesPerChange) {
      throw new AppError("too_many_files", `A change may contain at most ${this.config.maxFilesPerChange} files`);
    }
    const seen = new Set<string>();
    let totalBytes = 0;
    return changes.map((change) => {
      const path = this.assertWritablePath(change.path);
      if (seen.has(path)) throw new AppError("duplicate_path", `Duplicate file path: ${path}`);
      seen.add(path);
      if (change.operation === "upsert") {
        const bytes = Buffer.byteLength(change.content, "utf8");
        if (bytes > this.config.maxFileBytes) {
          throw new AppError("file_too_large", `${path} exceeds MAX_FILE_BYTES (${this.config.maxFileBytes})`);
        }
        if (isLikelyBinary(change.content)) throw new AppError("binary_content", `${path} appears to be binary`);
        totalBytes += bytes;
      }
      return { ...change, path } as FileChange;
    }).map((change) => {
      if (totalBytes > this.config.maxTotalChangeBytes) {
        throw new AppError("change_too_large", `Total content exceeds MAX_TOTAL_CHANGE_BYTES (${this.config.maxTotalChangeBytes})`);
      }
      return change;
    });
  }

  makeBranchName(requested: string | undefined, slug: string): string {
    const prefix = this.config.branchPrefix.endsWith("/") ? this.config.branchPrefix : `${this.config.branchPrefix}/`;
    const segment = sanitizeBranchSegment(requested ?? `${slug}-${Date.now()}`);
    if (!segment) throw new AppError("invalid_branch", "Branch name is empty after sanitization");
    const branch = segment.startsWith(prefix) ? segment : `${prefix}${segment}`;
    if (branch.includes("..") || branch.endsWith(".") || branch.endsWith("/") || branch.includes("@{")) {
      throw new AppError("invalid_branch", `Invalid branch name: ${branch}`);
    }
    return branch;
  }

  assertTargetBranchAllowed(target: string, defaultBranch: string): void {
    if (!this.config.allowDefaultBranchWrite && target === defaultBranch) {
      throw new AppError("default_branch_write_disabled", `Direct writes to ${defaultBranch} are disabled`, 403);
    }
  }

  assertMergeAllowed(): void {
    if (!this.config.allowMerge) throw new AppError("merge_disabled", "Pull request merging is disabled", 403);
  }

  assertDeleteBranchAllowed(): void {
    if (!this.config.allowDeleteBranch) throw new AppError("delete_branch_disabled", "Branch deletion is disabled", 403);
  }
}
