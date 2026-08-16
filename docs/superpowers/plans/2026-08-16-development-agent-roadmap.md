# Development Agent Roadmap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Codex-style workflow discipline, repository intelligence, bounded read-only vision, capability awareness, and GitHub CI verification to the existing development bridge.

**Architecture:** Keep `src/mcp.ts` as composition/registration code and move new behavior into focused workflow/local/GitHub service modules. Extend the existing local RPC dispatcher so the Mac performs repository/Git/visual operations, and convert screenshot payloads into MCP image blocks at the gateway boundary.

**Tech Stack:** TypeScript 6, Node 24, MCP SDK 1.29, Octokit, Zod, Vitest, native Git/rg/macOS `screencapture` + `sips`.

## Global Constraints

- Work only in the isolated worktree on `chatgpt/codex-agent-roadmap`.
- Do not open/focus/redirect/replace browser or editor tabs.
- Preserve unrelated behavior and existing GitHub/local/Gmail/OAuth/audit functionality.
- No mouse clicking, keyboard typing, arbitrary UI automation, continuous screenshots, webcam, microphone, or permission bypasses.
- `LOCAL_AGENT_MAX_SCREENSHOT_BYTES=1500000` and `LOCAL_AGENT_SCREENSHOT_MAX_EDGE=1600` are the defaults.
- TDD for every production behavior change.

---

### Task 1: Codex-style workflow and repository instruction discovery

**Files:**
- Create: `src/workflows/development.ts`
- Modify: `src/mcp.ts`
- Test: `tests/mcp.test.ts`

**Interfaces:**
- Produces: `DEVELOPMENT_INSTRUCTIONS: string[]` and `developmentWorkflowText(input)`.

- [ ] Add failing MCP tests asserting global inspect-before-edit/testing/final-verification/AGENTS rules and `development_workflow` prompt registration while `safe_github_development` remains registered.
- [ ] Run `npm test -- tests/mcp.test.ts` and verify the new assertions fail because the workflow is missing.
- [ ] Implement `src/workflows/development.ts`, import it from `src/mcp.ts`, register `development_workflow` with `repository`, `task`, and optional `workingDirectory` arguments.
- [ ] Re-run the focused MCP tests, then the full test suite.
- [ ] Commit the task.

### Task 2: Project context, fast code search, and Git review

**Files:**
- Create: `src/local/project-context.ts`
- Create: `src/local/code-search.ts`
- Create: `src/local/git-review.ts`
- Modify: `src/local/dispatcher.ts`
- Modify: `src/local/mcp-tools.ts`
- Test: `tests/local-development-tools.test.ts`
- Test: `tests/local-dispatcher.test.ts`
- Test: `tests/mcp.test.ts`

**Interfaces:**
- Produces: `getProjectContext(workingDirectory)`, `searchCode(input)`, `reviewGit(input)` and RPC methods `development.projectContext`, `development.codeSearch`, `development.gitReview`.

- [ ] Write failing tests using temporary Git repositories for Node/Python detection, branch/dirty state/AGENTS discovery, `rg` results/line numbers/ignore behavior, and bounded Git patches.
- [ ] Run the focused tests and verify failures are due to missing modules/RPC methods.
- [ ] Implement conservative project metadata detection from actual files/scripts and Git state.
- [ ] Implement `rg` search with `.gitignore`, binary/dependency exclusions, glob filters, result caps, and bounded context; return a clear `rg_not_available` local error if missing.
- [ ] Implement structured Git review with branch/head/upstream/ahead/behind/staged/unstaged/untracked/conflicts/diff stat and optional bounded patch.
- [ ] Register read-only MCP tools `local_get_project_context`, `local_code_search`, and `local_git_review` requiring `local:read`.
- [ ] Run focused tests and full suite.
- [ ] Commit the task.

### Task 3: Read-only visual subsystem and screenshot transport

**Files:**
- Create: `src/local/visual.ts`
- Modify: `src/local/dispatcher.ts`
- Modify: `src/local/agent.ts`
- Modify: `src/local/mcp-tools.ts`
- Modify: `src/config.ts`
- Test: `tests/local-visual.test.ts`
- Test: `tests/local-dispatcher.test.ts`
- Test: `tests/mcp.test.ts`

**Interfaces:**
- Produces: `LocalVisualService`, `MacVisualService`, RPC methods `visual.uiContext`, `visual.captureScreen`, MCP tools `local_get_ui_context`, `local_capture_screen`.

- [ ] Write failing tests with a fake visual service for UI context, capture dispatch, `local:read` authorization, image content block, MIME type, no base64 duplication, size-limit behavior, cleanup, unsupported platform, and Screen Recording permission errors.
- [ ] Run focused tests and verify expected failures.
- [ ] Add screenshot size/edge config to gateway and local-agent runtime config.
- [ ] Implement UI context using AppleScript only to query the frontmost application/window title; do not activate or focus applications.
- [ ] Implement screenshot capture with `screencapture` + `sips`, temporary files, bounded resizing, base64 image payload, and `finally` cleanup.
- [ ] Convert capture payload into MCP `{type:"image", data, mimeType:"image/png"}` content while keeping only metadata in structured content.
- [ ] Register both tools as read-only and require only `local:read`.
- [ ] Run focused tests and full suite.
- [ ] Commit the task.

### Task 4: Capability awareness

**Files:**
- Create: `src/local/capabilities.ts`
- Modify: `src/local/dispatcher.ts`
- Modify: `src/local/mcp-tools.ts`
- Modify: `src/mcp.ts`
- Test: `tests/local-development-tools.test.ts`
- Test: `tests/mcp.test.ts`

**Interfaces:**
- Produces: `getLocalCapabilities()` / RPC `system.capabilities` / MCP `local_get_capabilities`.

- [ ] Add failing tests for local filesystem/shell/terminal/process/vision reporting and MCP tool registration.
- [ ] Run focused tests and verify failure.
- [ ] Implement conservative capabilities based on platform/runtime/tool availability; do not claim Screen Recording permission is granted unless capture capability can establish it.
- [ ] Add workflow instruction to inspect capabilities before proposing manual workarounds.
- [ ] Run focused/full tests.
- [ ] Commit the task.

### Task 5: GitHub Actions / CI awareness

**Files:**
- Modify: `src/github/service.ts`
- Modify: `src/mcp.ts`
- Modify: `tests/helpers.ts`
- Modify: `tests/github-service.test.ts`
- Modify: `tests/mcp.test.ts`

**Interfaces:**
- Produces: `getCheckStatus(repository, ref)`, `listWorkflowRuns(repository, options)`, `getWorkflowRun(repository, runId)` and three read-only GitHub MCP tools.

- [ ] Add failing service/MCP tests for check summaries, workflow-run listing/details, and `github:read` scope enforcement.
- [ ] Verify red tests.
- [ ] Implement Octokit calls using repository installation auth and bounded response shapes; include failed-job log metadata only if supported cleanly, otherwise omit that optional roadmap extension.
- [ ] Register `github_get_check_status`, `github_list_workflow_runs`, and `github_get_workflow_run`.
- [ ] Update workflow instructions to distinguish local tests from remote CI.
- [ ] Run focused/full tests.
- [ ] Commit the task.

### Task 6: Safety classification, docs, environment, regression suite

**Files:**
- Modify: `README.md`
- Modify: `.env.example`
- Modify: relevant MCP/local tests

**Interfaces:**
- Documents all new tools and exact screenshot defaults.

- [ ] Add regression assertions that read tools remain non-destructive and recursive deletion/process kill/merge/default-branch-sensitive operations retain destructive classification.
- [ ] Verify any new regression assertions fail before metadata corrections.
- [ ] Make only required annotation/instruction corrections.
- [ ] Document workflow, AGENTS support, project context, code search, Git review, vision permissions/privacy, capability reporting, and CI verification.
- [ ] Add screenshot variables to `.env.example` and Mac-only variable section.
- [ ] Run `npm run test`, `npm run typecheck`, `npm run build`, and `npm run check`.
- [ ] Inspect `git status --short`, `git diff --check`, `git diff --stat`, and the complete diff for unexpected changes.
- [ ] Run real local smoke calls for project context, code search, Git review, UI context, and (only if Screen Recording permission already permits it) one screenshot capture. Do not open or focus any app to manufacture a visual test.
- [ ] Commit documentation/final regression changes.

### Task 7: Integration branch completion

**Files:** none beyond prior tasks.

- [ ] Verify the isolated branch is clean and all commits are present.
- [ ] Compare against `main` and confirm no unrelated changes.
- [ ] Push the feature branch and create a PR through the existing safe GitHub workflow without merging unless explicitly appropriate.
- [ ] Inspect actual CI status if available and report local-vs-remote verification separately.
