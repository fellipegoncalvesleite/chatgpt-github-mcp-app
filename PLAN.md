# ChatGPT Development Bridge — Project Plan

## Purpose

This project is a self-hosted MCP bridge for a single user or small trusted environment. It gives ChatGPT two kinds of development access:

1. GitHub App access for repository inspection and PR-based code changes.
2. An optional Mac local agent for filesystem, shell, terminal, process, Git, test, and debugger operations on the user's actual machine.

It is not a separate chat UI and it is not intended to be a public multi-tenant coding service.

## Architecture

```text
User ↔ ChatGPT
        |
        | MCP Streamable HTTP + OAuth 2.1
        v
Public Development Bridge
  |                 |
  | GitHub App      | authenticated long-poll RPC
  v                 v
GitHub          Mac local agent
                    |
                    +-- filesystem
                    +-- shell
                    +-- persistent terminal
                    +-- process control
                    +-- native developer tools
```

The Mac always initiates outbound requests to the public service. The design does not require a public SSH server or inbound terminal endpoint on the Mac.

## GitHub mode

GitHub mode provides:

- repository allowlisting
- repository metadata/tree/file reads
- pull-request inspection
- atomic multi-file commits
- managed `chatgpt/*` branches
- Pull Request creation
- PR comments
- optional merge and branch deletion

Default policy blocks direct default-branch writes, workflow edits, secret-like paths, automatic merges, and branch deletion.

## Local-agent mode

The local agent is intentionally a different trust boundary. When enabled, `local:write` can execute arbitrary shell commands and mutate any path the macOS account can access. No project-root sandbox or command allowlist is enforced.

The initial local-agent transport is dependency-free HTTPS long polling. The Mac asks the gateway for work, executes one typed RPC operation, then posts the correlated result. This avoids adding native/server transport dependencies during bootstrap.

Persistent interactive terminals use macOS `script(1)` as the v1 PTY wrapper. A later version may replace this with `node-pty` if true resize/ioctl control becomes important.

## OAuth scopes

- `github:read`
- `github:write`
- `github:merge` when merge support is enabled
- `local:read`
- `local:write`

## Secret separation

GitHub App credentials and OAuth signing material live only on the public gateway.

The local agent needs only:

- `LOCAL_AGENT_GATEWAY_URL`
- `LOCAL_AGENT_TOKEN`
- optional local resource-limit settings

The local-agent token is separate from the OAuth administrator password and GitHub credentials.

## Delivery phases

### Phase 1 — GitHub bridge

Implemented:

- GitHub App authentication
- allowlist and path policy
- GitHub read tools
- atomic branch/commit/PR write tool
- OAuth 2.1 + PKCE
- audit logging
- Docker/host deployment

### Phase 2 — Mac local agent

Implemented in the local-agent feature branch:

- authenticated outbound polling
- gateway connection/status reporting
- local file list/read/write/move/copy/delete/search
- arbitrary one-shot shell execution
- persistent interactive terminal sessions
- process listing/signaling
- local MCP tool registration
- separate local OAuth scopes
- LaunchAgent installer/uninstaller
- English public documentation

### Phase 3 — hardening after live bootstrap

After the first live Mac connection:

- run the complete test/build suite on the Mac
- exercise real Git/Test/REPL/debugger workflows
- tune output and timeout limits from actual usage
- consider replacing `script(1)` with `node-pty` for real terminal resize support
- consider streaming large shell/terminal output rather than bounded polling reads

## Acceptance criteria

The system is considered operational when:

- existing GitHub tools still work through ChatGPT
- `/healthz` reports whether the Mac agent is configured/connected
- ChatGPT can read and mutate arbitrary local paths permitted by macOS
- ChatGPT can run a shell command on the Mac and receive stdout/stderr/exit state
- ChatGPT can keep an interactive terminal alive across multiple MCP calls
- ChatGPT can run Git locally so commits use the local Git identity
- ChatGPT can run tests/builds and interact with a debugger/REPL
- the Mac exposes no new public inbound shell port
- local-agent secrets never appear in MCP results or audit logs
- public documentation and web/OAuth pages are English-only
