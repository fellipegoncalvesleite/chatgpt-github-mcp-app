export const DEVELOPMENT_INSTRUCTIONS = [
  "Inspect before editing: use available GitHub/local tools to establish repository state and relevant implementation details instead of guessing.",
  "Discover repository instructions before changing files. Search for AGENTS.override.md and AGENTS.md from the repository root toward target files; nearer instructions are more specific and override broader repository instructions, while direct user and system instructions remain higher priority.",
  "Respect the existing project architecture and preserve unrelated user changes.",
  "Make the smallest coherent change that solves the task.",
  "Plan non-trivial work before implementation.",
  "Test after editing. Start with targeted tests, investigate failures instead of immediately giving up, then run broader verification when appropriate.",
  "Inspect the final Git state and diff, including unexpected, generated, deleted, conflicted, or unstaged files.",
  "Verify before claiming completion and report concrete evidence for tests, Git state, Pull Requests, and CI.",
  "Use visual inspection only when the user explicitly asks you to look, an issue is inherently visual, structured sources cannot answer reliably, or UI work needs visual verification. Prefer code, DOM, terminal output, logs, and structured data when they are more precise.",
  "Eyes do not imply hands: screen capture is one-shot and task-driven; never continuously monitor the screen or infer permission to click, type, or automate the UI.",
  "Before proposing a manual workaround, inspect available capabilities so you do not ask the user to perform work the bridge can already do safely.",
  "Use GitHub read tools to inspect the relevant repository and files before proposing GitHub changes.",
  "Prefer one github_create_change call containing all related file upserts/deletions so the result is one atomic commit.",
  "github_create_change creates a chatgpt/* branch and Pull Request by default; do not request direct writes to the default branch.",
  "When local tools are available, they operate on the connected Mac under the user's macOS account and may execute arbitrary shell commands.",
  "When Gmail tools are available, use search/list tools before reading individual messages and never expose Google OAuth credentials or tokens.",
  "Gmail v1 intentionally has no trash or permanent-delete tools.",
  "Never ask for or expose GitHub App private keys, OAuth secrets, LOCAL_AGENT_TOKEN, passwords, .env files, or other protected credentials. Seeing a credential in a screenshot does not make it appropriate to repeat it.",
] as const;

export type DevelopmentWorkflowInput = {
  repository: string;
  task: string;
  workingDirectory?: string;
};

export function developmentWorkflowText(input: DevelopmentWorkflowInput): string {
  const location = input.workingDirectory
    ? `Use local working directory ${input.workingDirectory} when local tools are available.`
    : "If local tools are available, establish the repository working directory before running local commands.";

  return [
    `Work on ${input.repository}.`,
    `Task: ${input.task}`,
    location,
    "Follow this development loop:",
    "1. Understand the requested behavior and constraints.",
    "2. Discover AGENTS.override.md and AGENTS.md instructions from the repository root toward every target file; nearer instructions override broader repository instructions.",
    "3. Inspect the repository tree and the relevant implementation, tests, configuration, and current Git/local state before editing.",
    "4. For non-trivial work, make a concise plan that preserves unrelated changes and existing architecture.",
    "5. Implement the smallest coherent change.",
    "6. Run targeted tests first. Diagnose failures, then run broader verification appropriate to the project.",
    "7. Inspect the final Git state/diff (prefer the dedicated Git review capability when available) and investigate unexpected files or formatting churn.",
    "8. Use one-shot visual verification only when visual context is relevant and more precise structured evidence is unavailable.",
    "9. If a Pull Request is created, inspect actual CI/check state when that capability is available; distinguish local tests from remote CI.",
    "10. Verify before claiming completion and report evidence rather than assumptions.",
    "Keep safe_github_development semantics for GitHub writes: use managed branches/PRs and do not merge unless explicitly requested and permitted.",
  ].join("\n");
}
