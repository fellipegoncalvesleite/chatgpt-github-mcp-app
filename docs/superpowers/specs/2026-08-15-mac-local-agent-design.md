# Mac Local Agent Design

## Summary

Extend the existing ChatGPT GitHub MCP App into a two-part development system:

1. A public MCP gateway that remains reachable by ChatGPT and keeps the existing OAuth/GitHub tool behavior.
2. A Mac-side local agent that runs under the user's macOS account and provides unrestricted local filesystem and shell capabilities, including persistent interactive terminals for debugging and long-running development workflows.

The public gateway should not execute local development commands itself. Instead, the Mac agent establishes an authenticated outbound connection to the gateway and receives local tool requests through that channel. This preserves the existing ChatGPT connector while allowing commands to run on the user's actual Mac rather than inside Railway or another hosting provider.

This change also converts the repository's public-facing Chinese documentation to English.

## Goals

- Preserve all existing GitHub MCP tools and OAuth behavior.
- Add local filesystem access across the user's machine without hardcoded workspace-root restrictions.
- Add unrestricted shell execution under the logged-in macOS user account.
- Permit commands to invoke `sudo`; macOS authentication and policy remain the final authority on whether elevated execution succeeds.
- Add persistent PTY-backed terminal sessions so ChatGPT can interact with debuggers, REPLs, dev servers, test runners, and commands that wait for input.
- Allow workflows such as inspect → run → fail → debug → edit → rerun → test → commit → push.
- Keep the Mac-side service non-public: it should initiate an outbound authenticated connection to the public gateway rather than expose a public shell endpoint.
- Make local-agent connection state observable so ChatGPT can distinguish "Mac offline" from a tool failure.
- Keep the deployment provider replaceable. Railway can remain the first gateway host, but the design should not couple the local agent to Railway-specific APIs.
- Translate README/PLAN public documentation to English and update the project framing to mention the optional local development agent.

## Non-goals

- Building a graphical IDE.
- Reimplementing Git, debuggers, or package managers when the Mac can invoke the native tools directly.
- Sandboxing the local shell to selected project folders.
- Maintaining a command allowlist.
- Hiding dangerous capabilities from the MCP schema. Local write/execute tools should be described accurately as mutating/destructive where appropriate.
- Storing macOS login passwords, sudo passwords, SSH private keys, or arbitrary shell credentials in the gateway.

## Permission Model

The user explicitly selected the unrestricted model.

### Filesystem

The local agent may address absolute paths anywhere the macOS user account can access. It must not enforce a project-root or home-directory allowlist. If the operating system denies a path, the tool returns that OS error.

### Shell

The local agent may execute arbitrary commands using the user's normal shell environment. There is no command allowlist or application-level restriction on `sudo`, filesystem mutation, process control, package installation, Git operations, or developer tooling.

The implementation must not silently inject or persist passwords. If a command needs interactive authentication, it can run in a PTY and surface the prompt. ChatGPT can continue interacting with the session, but credentials remain subject to normal platform/user confirmation behavior and should never be embedded into server configuration.

### Platform layer

The MCP server should accurately annotate local tools as read-only or mutating/destructive. ChatGPT or the hosting platform may still impose its own confirmation or policy layer; the local agent must not attempt to bypass that layer.

## Architecture

```text
ChatGPT
   |
   | MCP Streamable HTTP + existing OAuth
   v
Public MCP Gateway
   |  (Railway initially; host-agnostic design)
   |
   | authenticated persistent agent channel
   v
Mac Local Agent
   |
   +-- filesystem service
   +-- one-shot process runner
   +-- PTY session manager
   +-- process inspection/control
   +-- native git/test/debug tools via shell
```

### Public MCP gateway

The existing Express/MCP application remains the endpoint connected to ChatGPT. Existing GitHub tools remain unchanged.

New local tools are registered in the same MCP server. Their handlers validate OAuth scopes, ensure a Mac agent is connected, forward the operation to the agent, wait for the correlated response, audit the result, and return structured MCP output.

The gateway must never interpret a local path as a server filesystem path. All local operations are explicit RPC messages to the connected Mac agent.

### Mac local agent

The local agent is a separate Node.js entrypoint in the same repository. It runs on macOS and connects outbound to the gateway using a persistent WebSocket connection.

The agent owns all interaction with local files, child processes, and PTYs. It accepts typed RPC requests from the gateway and returns typed results/errors.

The agent should be runnable manually during development and installable as a per-user `launchd` service later so it reconnects automatically after login.

## Authentication and Transport

### Agent registration secret

The gateway and Mac agent share a separate high-entropy agent token that is unrelated to the existing ChatGPT OAuth password/signing secret and unrelated to GitHub App credentials.

Environment variables:

- Gateway: `LOCAL_AGENT_TOKEN`
- Mac: `LOCAL_AGENT_TOKEN`
- Mac: `LOCAL_AGENT_GATEWAY_URL`

The token is used only to authenticate the agent connection. It must not be returned through MCP tools or audit logs.

### Outbound connection

The Mac agent opens a TLS WebSocket to the public gateway, for example:

```text
wss://example.com/local-agent
```

The Mac initiates the connection. No inbound port, SSH server, or public tunnel to the Mac is required.

The connection handshake authenticates with the local-agent token. The gateway allows one active agent for the single-user deployment. A newer authenticated connection may replace a stale one.

### RPC envelope

Requests and responses use small JSON envelopes with unique IDs.

Request:

```json
{
  "type": "request",
  "id": "uuid",
  "method": "shell.run",
  "params": {}
}
```

Response:

```json
{
  "type": "response",
  "id": "uuid",
  "ok": true,
  "result": {}
}
```

Error:

```json
{
  "type": "response",
  "id": "uuid",
  "ok": false,
  "error": {
    "code": "process_failed",
    "message": "..."
  }
}
```

The gateway maintains pending requests by ID and rejects them with an `agent_disconnected` error if the connection closes.

## MCP Tool Surface

The first implementation should expose the following local tools.

### Host information

`local_get_info`

Returns connection status and basic machine/runtime facts such as hostname, platform, architecture, home directory, shell, current agent version, and uptime. It must not enumerate secrets.

### Filesystem

`local_list_directory(path)`

Lists directory entries with type and basic stat metadata.

`local_read_file(path, encoding?)`

Reads a local file. Initial implementation supports UTF-8 text and bounded binary-to-base64 only if a clear MCP need is established; text is the required v1 path.

`local_write_file(path, content, createParents?)`

Writes/replaces a UTF-8 file. Optional parent creation is explicit.

`local_move(source, destination, overwrite?)`

Moves or renames a file/directory using native filesystem semantics.

`local_copy(source, destination, recursive?, overwrite?)`

Copies local files/directories.

`local_delete(path, recursive?, force?)`

Deletes a file or directory. This is explicitly destructive.

`local_search_files(root, query, maxResults?)`

Searches paths/content in the specified local root. Implementation may use native Node traversal initially; later optimization can use `rg` when available.

### One-shot shell

`local_run(command, cwd?, env?, timeoutMs?)`

Runs an arbitrary command through the user's shell and captures stdout, stderr, exit code, termination signal, duration, and truncation metadata.

`cwd` accepts any path accessible to the user. `env` overlays the inherited process environment rather than replacing it.

Output must have configurable byte limits so an accidental infinite stream cannot exhaust the gateway connection.

### Persistent terminals

`local_terminal_start(command?, cwd?, cols?, rows?, env?)`

Creates a PTY session. With no command, launch the configured interactive shell. Returns a session ID.

`local_terminal_read(sessionId, cursor?)`

Returns terminal output since a cursor/offset plus current process/session state.

`local_terminal_send(sessionId, input)`

Writes exact input bytes/text to the PTY.

`local_terminal_resize(sessionId, cols, rows)`

Resizes the PTY.

`local_terminal_stop(sessionId, signal?)`

Terminates the session/process tree and releases resources.

Persistent PTYs are required for `pdb`, `lldb`, interactive CLIs, REPLs, servers, password prompts handled by the user, and long-running commands.

### Process inspection

`local_process_list(filter?)`

Returns a bounded process list based on native macOS process information.

`local_process_kill(pid, signal?)`

Sends a signal to a process the user account is permitted to signal.

## Implementation Boundaries

### Gateway modules

Keep `src/mcp.ts` from becoming the owner of transport state. Introduce focused modules:

- `src/local/protocol.ts`: request/response schemas and shared TypeScript types.
- `src/local/gateway.ts`: WebSocket connection lifecycle, authentication, pending request correlation, timeouts, disconnect behavior.
- `src/local/mcp-tools.ts`: MCP registration for local tools, scope checks, annotations, audit integration, and RPC calls into `LocalAgentGateway`.

`src/mcp.ts` composes the existing GitHub tools with `registerLocalTools(...)`.

### Mac agent modules

- `src/local/agent.ts`: executable entrypoint and reconnect loop.
- `src/local/dispatcher.ts`: validates RPC methods and dispatches to focused services.
- `src/local/filesystem.ts`: filesystem operations.
- `src/local/shell.ts`: one-shot command execution.
- `src/local/terminal.ts`: PTY session lifecycle.
- `src/local/processes.ts`: process listing/signaling.

Do not place local execution code inside GitHub service modules.

## Dependencies

Add only what the design needs:

- `ws` for authenticated persistent WebSocket transport.
- `node-pty` for real PTY-backed terminal sessions on macOS.

Prefer Node built-ins for filesystem, process creation, streams, and path handling.

## OAuth Scopes

Add separate scopes so local-machine capabilities are distinguishable from GitHub access:

- `local:read` for machine info, directory listing, file reads/search, terminal reads, and process listing.
- `local:write` for file mutation, shell execution, terminal creation/input/termination, and process signaling.

Existing GitHub scopes remain unchanged.

The OAuth authorization UI/documentation must make the local capabilities clear.

## Reliability

### Reconnection

The Mac agent reconnects with exponential backoff capped at a reasonable maximum. It sends periodic heartbeats. The gateway tracks last-seen state.

### In-flight requests

When the WebSocket disconnects, pending gateway RPCs fail immediately rather than hanging until their normal timeout.

### Command timeouts

One-shot commands have an explicit timeout with a server-configured maximum. PTY sessions do not inherit one-shot timeouts and continue until stopped, exited, or the agent process shuts down.

### Agent restarts

Terminal sessions are in-memory and are lost when the Mac agent restarts. Tools must return `session_not_found` rather than guessing state.

## Output and Size Limits

Unrestricted permissions do not require unbounded payloads.

Add configurable limits for:

- maximum file-read response bytes;
- maximum one-shot stdout/stderr captured bytes;
- maximum terminal retained scrollback bytes;
- maximum concurrent terminal sessions;
- RPC timeout;
- reconnect/heartbeat timing.

If output is truncated, results must say so explicitly.

These are resource-protection limits, not permission restrictions.

## Auditing

Continue using the existing JSONL audit system.

For local tools, record:

- tool name;
- actor/client metadata;
- path(s) or cwd when applicable;
- terminal session ID when applicable;
- outcome and sanitized error code/message.

Do not record:

- complete file content;
- stdout/stderr bodies;
- terminal scrollback;
- environment variable values;
- local-agent token;
- OAuth/GitHub secrets.

## Error Model

Use stable error codes so ChatGPT can react correctly:

- `agent_not_configured`
- `agent_disconnected`
- `agent_timeout`
- `invalid_local_path`
- `file_too_large`
- `process_failed`
- `process_timeout`
- `session_not_found`
- `too_many_sessions`
- `rpc_protocol_error`

Native OS error messages may be included as human-readable details, but stable codes drive tool behavior.

## Testing Strategy

### Protocol tests

Validate every RPC envelope and reject malformed method/parameter combinations.

### Gateway tests

Use a fake WebSocket agent to verify:

- valid authentication;
- invalid token rejection;
- request/response correlation;
- timeout behavior;
- disconnect rejection of pending calls;
- replacement of stale connections;
- heartbeat/online status.

### Filesystem tests

Run against temporary directories and verify list/read/write/move/copy/delete/search behavior with absolute paths and spaces/unicode in filenames.

### Shell tests

Verify stdout/stderr separation, non-zero exit codes, `cwd`, environment overlay, timeout killing, and output truncation.

### PTY tests

Verify start/read/send/resize/stop using a simple interactive Node or shell process. Include a test that proves an input-dependent process can be driven across multiple MCP calls.

### MCP tests

Verify local tools are registered with the correct schemas, scopes, and read/destructive annotations, and that local RPC failures become structured MCP errors.

### Regression tests

All existing GitHub/OAuth/policy tests must remain passing.

## Documentation Changes

Translate `README.md` and `PLAN.md` to English rather than maintaining parallel Chinese/English copies.

README should explain two operating modes:

1. GitHub-only remote MCP, which can run entirely on the public server.
2. Optional Mac local-agent mode, which adds local files, shell, terminal, debugging, and Git execution on the user's machine.

Document explicitly that a shell tool on Railway executes on Railway, which is why local execution requires the Mac agent.

Provide setup instructions for:

- generating/configuring `LOCAL_AGENT_TOKEN`;
- configuring the gateway WebSocket endpoint;
- running the Mac agent manually;
- installing/removing its per-user `launchd` service;
- checking agent connectivity;
- rotating the agent token.

Never instruct users to commit local-agent tokens or passwords to Git.

## Deployment

The public gateway remains deployable with the existing Docker/Railway approach. WebSocket support must work behind the existing HTTPS deployment.

The local agent is launched directly on macOS with Node.js and native `node-pty` bindings. It is not deployed to Railway.

A future migration from Railway to Koyeb, Render, Fly.io, or another HTTPS/WebSocket-capable provider should require only changing the public URL and secrets, not rewriting the agent protocol.

## Rollout

1. Add protocol and gateway connection layer with tests.
2. Add filesystem + one-shot shell tools and verify end-to-end through a local agent.
3. Add PTY/process tools and debugging flows.
4. Add launchd installer/service configuration.
5. Translate and update public docs.
6. Run the full existing test/build suite and perform a live test from ChatGPT against the connected Mac.

## Acceptance Criteria

The feature is complete when all of the following are true:

- Existing GitHub MCP behavior still passes its test suite.
- ChatGPT can report whether the Mac agent is connected.
- ChatGPT can list/read/write/move/copy/delete files at arbitrary paths available to the macOS user.
- ChatGPT can run an arbitrary one-shot shell command on the Mac and receive its result.
- ChatGPT can start a PTY, read its output, send input, and stop it across separate MCP calls.
- A real interactive debugger or REPL can be operated across multiple calls.
- Commands execute on the Mac, not on the public hosting container.
- The Mac exposes no inbound public shell/listening port solely for this feature.
- Agent reconnection and gateway disconnect errors are deterministic and test-covered.
- Local-agent secrets never appear in MCP results or audit logs.
- README and PLAN are English-only and describe both GitHub-only and local-agent modes accurately.
