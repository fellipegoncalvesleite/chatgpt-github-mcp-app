# ChatGPT Development Bridge

A self-hosted MCP service that lets ChatGPT work with your GitHub repositories and, optionally, operate a development environment on your Mac.

The project has two independent modes:

1. **GitHub mode** — the public MCP gateway reads repositories and creates branch/commit/PR changes through a GitHub App.
2. **Mac local-agent mode** — a process running on your Mac connects outward to the gateway and exposes local filesystem, shell, persistent terminal, process, Git, test, and debugger workflows.

The Mac agent is intentionally powerful. In the unrestricted configuration it can access any path your macOS account can access and can run arbitrary shell commands, including commands that invoke `sudo`. macOS itself remains the final authority on filesystem permissions and elevation.

## Why the Mac agent exists

A shell command executed directly by a Railway/Render/Koyeb process runs **inside that hosting container**, not on your computer. The local agent solves that by keeping ChatGPT connected to the same public MCP URL while forwarding local-tool requests to a process actually running on your Mac.

The Mac initiates the connection using authenticated long polling. You do not expose SSH, a terminal port, or an inbound HTTP server on the Mac.

## MCP tools

### GitHub

- `github_list_repositories`
- `github_get_repository`
- `github_list_tree`
- `github_read_file`
- `github_list_pull_requests`
- `github_get_pull_request`
- `github_create_change`
- `github_comment_pull_request`
- optional `github_merge_pull_request`
- optional `github_delete_branch`

### Mac local agent

Read tools:

- `local_get_info`
- `local_list_directory`
- `local_read_file`
- `local_search_files`
- `local_terminal_read`
- `local_process_list`

Mutating/execution tools:

- `local_write_file`
- `local_move`
- `local_copy`
- `local_delete`
- `local_run`
- `local_terminal_start`
- `local_terminal_send`
- `local_terminal_resize`
- `local_terminal_stop`
- `local_process_kill`

The persistent terminal is PTY-backed on macOS through the native `script(1)` utility, which is enough for interactive shells, REPLs, debuggers, and long-running commands. The dependency-free v1 does not expose a true PTY resize ioctl; `local_terminal_resize` is best-effort and reports that limitation.

## Requirements

Public gateway:

- Node.js 22+
- a GitHub App
- a public HTTPS URL reachable by ChatGPT

Mac agent:

- macOS
- Node.js 22+
- a local clone of this repository
- outbound HTTPS access to the public gateway

## 1. Create the GitHub App

In GitHub, open **Settings → Developer settings → GitHub Apps → New GitHub App**.

Repository permissions:

- Contents: **Read and write**
- Pull requests: **Read and write**
- Metadata: **Read-only**

Disable webhooks unless you add a separate feature that needs them. Install the app only on repositories ChatGPT should be able to access.

Record the App ID and generate a private key.

## 2. Configure the public gateway

```bash
cp .env.example .env
npm install
npm run generate:secrets -- 'choose-a-new-admin-password'
```

Copy the generated values into your hosting provider's secret/environment settings. Do not paste private keys, OAuth secrets, or `LOCAL_AGENT_TOKEN` into chat.

Important variables:

```env
PUBLIC_BASE_URL=https://your-public-host.example.com
GITHUB_APP_ID=...
GITHUB_PRIVATE_KEY_BASE64=...
GITHUB_ALLOWED_REPOSITORIES=owner/repo,owner/another-repo
OAUTH_SIGNING_SECRET=...
OAUTH_ADMIN_PASSWORD_HASH=scrypt:...
LOCAL_AGENT_TOKEN=...
```

If you only want GitHub mode, leave `LOCAL_AGENT_TOKEN` empty.

Build and start:

```bash
npm run build
npm start
```

Health:

```bash
curl https://your-public-host.example.com/healthz
```

The health response includes a non-secret `localAgent` status object.

## 3. Connect ChatGPT

Add this URL as the custom MCP app:

```text
https://your-public-host.example.com/mcp
```

Complete the OAuth approval flow. The service advertises:

- `github:read`
- `github:write`
- optional `github:merge`
- `local:read`
- `local:write`

If you deploy a version that adds tools/scopes after the app was already connected, refresh/reconnect the custom MCP app so ChatGPT discovers the new tool schema.

## 4. Bootstrap the Mac local agent

Pull the version containing the local agent onto the Mac, then:

```bash
npm install
npm run build
mkdir -p ~/.config
chmod 700 ~/.config
```

Create `~/.config/chatgpt-local-agent.env`:

```env
LOCAL_AGENT_GATEWAY_URL=https://your-public-host.example.com
LOCAL_AGENT_TOKEN=the-exact-same-token-configured-on-the-gateway
```

Lock it down:

```bash
chmod 600 ~/.config/chatgpt-local-agent.env
```

Run the agent in the foreground for the first test:

```bash
npm run local-agent
```

Then call `local_get_info` from ChatGPT. A successful response should show the Mac hostname, home directory, shell, Node version, and `connected: true`.

The agent does not impose its own path sandbox, but macOS privacy/TCC controls still apply. If you want it to reach privacy-protected locations that macOS denies, grant the Node executable running the agent the corresponding macOS permission (for example Full Disk Access).

## 5. Install the Mac agent at login

After the foreground test works:

```bash
npm run local-agent:install
```

This builds the project and installs a per-user LaunchAgent:

```text
~/Library/LaunchAgents/dev.fellipe.chatgpt-local-agent.plist
```

The plist contains paths, not the agent secret. It loads the secret from:

```text
~/.config/chatgpt-local-agent.env
```

Log output:

```text
~/Library/Logs/chatgpt-local-agent.log
```

Remove it with:

```bash
npm run local-agent:uninstall
```

## 6. What local execution can do

`local_run` executes:

```text
$SHELL -lc '<command>'
```

with the Mac agent's inherited environment plus any explicit environment overlay. It can run ordinary development commands such as:

```bash
git status
git diff
npm test
npm run build
python file.py
pytest
lldb ...
python -m pdb ...
```

Commands that require ongoing interaction should use the persistent terminal tools instead of `local_run`.

No application-level command allowlist or project-root sandbox is enforced. Output/file-size/session limits only protect the transport from accidental unbounded data.

## 7. Git identity

When ChatGPT uses the Mac agent to run normal local Git commands, commits use the Git identity configured in that local repository/user environment:

```bash
git config user.name
git config user.email
```

That is different from commits created by the GitHub App API.

## 8. Security boundaries

GitHub mode remains conservative by default:

- explicit repository allowlist
- `chatgpt/*` branches
- PR-based writes
- no default-branch direct write
- no automatic merge unless enabled
- protected GitHub repository paths

Local-agent mode is deliberately broader. The gateway only receives individual tool results; audit logs record tool metadata and sanitized errors, not file contents, shell output, terminal scrollback, environment values, or the local-agent token. The agent also removes its bridge credentials from child-process environments by default.

Because the shell and filesystem are intentionally unrestricted, **user-readable secrets on the Mac are not a sandbox boundary**: a command that explicitly reads a credential file can still return that file's contents. Do not treat the local agent as a secret-isolation mechanism.

Rotate `LOCAL_AGENT_TOKEN` by changing it on both the gateway and Mac, then restart both sides.

## 9. Development

```bash
npm run typecheck
npm run test
npm run build
npm run check
```

Tests cover GitHub safety, OAuth, MCP tool registration, local gateway request correlation, local filesystem/shell dispatch, and the Mac-agent request loop.

## 10. Hosting

The public gateway is host-agnostic. Railway works, but any provider that can keep a Node HTTPS service available long enough for MCP/OAuth requests and ~25-second long-poll requests can host it.

Moving providers only requires moving the gateway environment variables and changing `PUBLIC_BASE_URL` / `LOCAL_AGENT_GATEWAY_URL`.

## 11. Secrets

Never commit:

- `.env`
- GitHub App private keys
- OAuth store files
- audit logs
- `~/.config/chatgpt-local-agent.env`
- `LOCAL_AGENT_TOKEN`

The repository's `.env.example` contains placeholders only.
