# Mac Local Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the existing GitHub MCP gateway with an authenticated Mac-side agent that provides unrestricted local filesystem, shell, persistent terminal, process, and debugging capabilities while keeping the public gateway host-agnostic.

**Architecture:** ChatGPT continues to connect to the existing public Express/MCP service. A Mac agent establishes an outbound authenticated long-poll channel to the gateway; MCP local tools enqueue RPC requests and the Mac agent executes them locally. The first implementation intentionally uses only Node/macOS built-ins so the existing Railway dependency lock remains deployable before local terminal access exists.

**Tech Stack:** Node.js 22, TypeScript, Express 5, MCP SDK, Zod, Vitest, Node `fs/promises`, `child_process`, macOS `/usr/bin/script`, `ps`, and `kill`.

## Global Constraints

- Preserve all existing GitHub tools and OAuth behavior.
- Filesystem access is unrestricted to any path the macOS user can access.
- Shell execution has no application-level command allowlist and may invoke `sudo`.
- The Mac must initiate the connection; no inbound shell/listening port is exposed on the Mac.
- Never store or return passwords, GitHub credentials, OAuth secrets, or the local-agent token.
- Use `local:read` and `local:write` OAuth scopes for local-machine tools.
- Resource/output limits are allowed for reliability; they are not permission restrictions.
- Keep public-facing documentation English-only.
- Minimize commits: tests, implementation, and docs for this feature should land in one implementation commit after this plan.

---

### Task 1: Gateway RPC queue and HTTP agent endpoints

**Files:**
- Create: `src/local/protocol.ts`
- Create: `src/local/gateway.ts`
- Modify: `src/config.ts`
- Modify: `src/server.ts`
- Modify: `tests/helpers.ts`
- Create: `tests/local-gateway.test.ts`

**Interfaces:**
- `LocalAgentGateway.request(method, params): Promise<unknown>` queues one request for the connected Mac agent.
- `LocalAgentGateway.poll(agentId, waitMs): Promise<LocalRpcRequest | null>` returns queued work with long-poll waiting.
- `LocalAgentGateway.respond(agentId, response): void` resolves/rejects the matching pending request.
- `LocalAgentGateway.status()` returns configured/connected/lastSeen state.

- [ ] Write tests proving invalid agent tokens are rejected, polls establish online state, request/response correlation works, disconnect/timeout errors are stable, and health exposes agent status without secrets.
- [ ] Run `npm test -- tests/local-gateway.test.ts` and confirm the tests fail because the local gateway does not exist.
- [ ] Implement the protocol, gateway queue, configuration fields, and authenticated `/local-agent/*` routes.
- [ ] Run `npm test -- tests/local-gateway.test.ts` and confirm the gateway tests pass.

### Task 2: Local filesystem, shell, terminal, and process dispatcher

**Files:**
- Create: `src/local/filesystem.ts`
- Create: `src/local/shell.ts`
- Create: `src/local/terminal.ts`
- Create: `src/local/processes.ts`
- Create: `src/local/dispatcher.ts`
- Create: `tests/local-dispatcher.test.ts`

**Interfaces:**
- `dispatchLocalRequest(method, params, services): Promise<unknown>` validates and executes one RPC method.
- Filesystem methods support list/read/write/move/copy/delete/search with absolute or relative paths resolved by the Mac process.
- `runShell(...)` returns exit code, signal, stdout, stderr, duration, and truncation flags.
- `TerminalManager` owns persistent sessions and supports start/read/send/resize/stop.
- `listProcesses()` and `killProcess()` use native macOS commands/signals.

- [ ] Write tests for temporary-directory filesystem mutations/search, shell stdout/stderr/nonzero/timeout/cwd/env behavior, terminal multi-call input/output, and process listing.
- [ ] Run `npm test -- tests/local-dispatcher.test.ts` and confirm failure because dispatcher/services are absent.
- [ ] Implement the services with bounded output buffers and stable errors.
- [ ] Run `npm test -- tests/local-dispatcher.test.ts` and confirm they pass.

### Task 3: Mac agent executable and reconnect loop

**Files:**
- Create: `src/local/agent.ts`
- Modify: `package.json`
- Create: `scripts/install-local-agent.mjs`
- Create: `scripts/uninstall-local-agent.mjs`
- Create: `tests/local-agent.test.ts`

**Interfaces:**
- `runLocalAgent()` repeatedly polls the gateway, dispatches requests, posts responses, and reconnects with bounded backoff.
- `npm run local-agent` starts it manually.
- `npm run local-agent:install` creates a per-user LaunchAgent plist that runs the local clone after login.
- `npm run local-agent:uninstall` unloads/removes the plist.

- [ ] Write a fake-gateway test proving the agent polls, executes a request, posts the response, and retries after transient network failure.
- [ ] Run `npm test -- tests/local-agent.test.ts` and confirm failure because the executable does not exist.
- [ ] Implement the agent and launchd installer/uninstaller without embedding secrets in the plist; the plist points to a user-owned environment file outside the repo.
- [ ] Run `npm test -- tests/local-agent.test.ts` and confirm pass.

### Task 4: MCP local tools and OAuth scopes

**Files:**
- Create: `src/local/mcp-tools.ts`
- Modify: `src/mcp.ts`
- Modify: `src/oauth/provider.ts`
- Modify: `src/server.ts`
- Modify: `tests/mcp.test.ts`
- Modify: `tests/http.test.ts`

**Interfaces:**
- `registerLocalTools(server, { gateway, audit })` adds `local_get_info`, filesystem tools, `local_run`, terminal tools, and process tools.
- Read-only tools require `local:read`; mutating/executing tools require `local:write`.
- `createGitHubMcpServer` receives the shared `LocalAgentGateway` so stateless MCP requests use the same agent connection.

- [ ] Add tests proving tools are registered, scope checks work, local RPC results/errors map to MCP results, and OAuth discovery/authorization advertises local scopes.
- [ ] Run `npm test -- tests/mcp.test.ts tests/http.test.ts` and confirm the new expectations fail.
- [ ] Implement MCP registration and OAuth scope integration.
- [ ] Run those tests and confirm pass.

### Task 5: English documentation and deployment instructions

**Files:**
- Modify: `README.md`
- Modify: `PLAN.md`
- Modify: `.env.example`
- Modify: `src/server.ts`

**Interfaces:**
- README documents GitHub-only mode and optional Mac-agent mode.
- `.env.example` documents `LOCAL_AGENT_TOKEN`, agent RPC timeouts/limits, and Mac variables.
- Public HTML and OAuth approval UI are English-only.

- [ ] Replace Chinese public-facing documentation/UI text with concise English copy.
- [ ] Document the manual bootstrap sequence: deploy gateway variables, pull the repo on the Mac, create a local agent env file, run `npm run local-agent`, verify `local_get_info`, then optionally install the LaunchAgent.
- [ ] Run a repository text scan for Chinese copy in README/PLAN/server/OAuth/env template and remove remaining public-facing instances.

### Task 6: Full verification

**Files:** none beyond fixes required by verification.

- [ ] Run `npm run typecheck`.
- [ ] Run `npm run test`.
- [ ] Run `npm run build`.
- [ ] Run `npm run check`.
- [ ] Start the gateway locally with test-safe credentials and confirm `/healthz` reports local-agent status.
- [ ] Start the Mac agent against the deployed gateway and use MCP to run `local_get_info`, read a harmless file, execute `pwd`, start/read/stop a persistent terminal, and inspect `git status` in a local repo.
- [ ] Commit all implementation/test/documentation changes in one commit on `chatgpt/local-agent` and keep PR #1 as the single review surface.
