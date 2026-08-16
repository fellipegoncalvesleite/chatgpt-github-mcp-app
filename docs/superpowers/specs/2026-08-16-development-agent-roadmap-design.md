# Development Agent Roadmap Design

## Goal

Turn the bridge into a disciplined coding-agent environment while preserving the existing GitHub, local Mac, Gmail, OAuth, audit, and safety behavior.

## Constraints

- Keep the current running MCP usable while development happens; implementation work is isolated in a separate Git worktree.
- Never open, focus, redirect, replace, or automate browser/editor tabs as part of this implementation.
- Preserve the existing `safe_github_development` prompt for backwards compatibility.
- Prefer inspection and structured tools over guessing.
- Respect `AGENTS.override.md` / `AGENTS.md`, with nearer instructions overriding broader repository instructions and direct user/system instructions taking precedence.
- Visual access is read-only and one-shot: UI context and screenshots only. No clicking, typing, arbitrary UI automation, continuous screenshots, webcam, microphone, or permission bypasses.
- Screenshots use native macOS tools, are bounded by byte/edge limits, use temporary files, and delete temporary files in `finally`.
- Protected credentials stay protected whether they appear in files, environment variables, logs, or screenshots.
- High-impact actions remain accurately classified as destructive where appropriate.

## Architecture

### Workflow module

Create `src/workflows/development.ts` to own global development instructions and the `development_workflow` prompt text. `src/mcp.ts` imports these instead of accumulating more workflow prose inline.

### Local development intelligence

Add focused modules for repository context, ripgrep-backed code search, Git review, visual capture, and capability reporting. Expose them through new local RPC methods in `src/local/dispatcher.ts` and MCP tools in `src/local/mcp-tools.ts`.

### Vision boundary

Create a `LocalVisualService` interface in `src/local/visual.ts`. The default macOS implementation uses `/usr/sbin/screencapture` and `/usr/bin/sips`; tests inject a fake service. Screenshot responses cross the local RPC boundary as base64 plus metadata, and the MCP tool converts that into an MCP image content block without duplicating base64 in structured content.

### GitHub CI awareness

Extend `GitHubService` with check-status and Actions workflow-run methods, then register read-only MCP tools in `src/mcp.ts`. CI results must distinguish pending, passing, and failing states rather than collapsing them into a generic success claim.

### Configuration and docs

Add screenshot limits to gateway and local-agent configuration with defaults of `1500000` bytes and `1600` max edge. Document all new tools, permissions, environment variables, and the intended coding loop in README and `.env.example`.

## Testing strategy

Use TDD for behavior changes. Add focused tests for workflow registration/instructions, project detection, code search, Git review, visual dispatch/image transport/size cleanup/permission errors, capability reporting, GitHub CI service behavior, and regression coverage. Finish with `npm run test`, `npm run typecheck`, `npm run build`, and `npm run check`, then inspect Git status and diff.

## Definition of done

The agent can understand a coding task, discover repository instructions, inspect project context, search code efficiently, plan non-trivial work, edit through existing mechanisms, run tests, diagnose failures, inspect the screen only when relevant, review Git changes, create a PR, inspect CI, and report evidence accurately without introducing UI-control behavior.