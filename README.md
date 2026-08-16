# ChatGPT Development Bridge

A self-hosted MCP service that lets ChatGPT work with GitHub repositories, Gmail, and an optional Mac-side development environment through one MCP endpoint.

The project has three independent capabilities:

1. **GitHub mode** — the public MCP gateway reads repositories and creates branch/commit/PR changes through a GitHub App.
2. **Gmail mode** — the public gateway searches/reads mail, manages drafts, sends mail, archives messages, and changes labels through the Gmail API. Gmail does not depend on the Mac agent being online.
3. **Mac local-agent mode** — a process running on your Mac connects outward to the gateway and exposes local filesystem, shell, persistent terminal, process, Git, test, and debugger workflows.

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
- `github_get_check_status`
- `github_list_workflow_runs`
- `github_get_workflow_run`
- `github_create_change`
- `github_comment_pull_request`
- optional `github_merge_pull_request`
- optional `github_delete_branch`

### Gmail (optional)

Read tools:

- `gmail_get_profile`
- `gmail_search_messages`
- `gmail_read_message`
- `gmail_list_labels`
- `gmail_list_drafts`
- `gmail_read_draft`

Write tools:

- `gmail_create_draft`
- `gmail_send_message`
- `gmail_send_draft`
- `gmail_archive_messages`
- `gmail_modify_labels`

Gmail v1 intentionally exposes no trash/untrash or permanent-delete tools. The upstream Google grant uses only `https://www.googleapis.com/auth/gmail.modify`, not the broader `https://mail.google.com/` scope.

### Mac local agent

Read tools:

- `local_get_info`
- `local_get_capabilities`
- `local_get_project_context`
- `local_code_search`
- `local_git_review`
- `local_get_ui_context`
- `local_capture_screen`
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

### Coding-agent workflow

The MCP publishes a `development_workflow` prompt for non-trivial coding work. Its intended loop is:

```text
understand → discover AGENTS instructions → inspect → plan → implement → targeted tests → diagnose → broader verification → Git review → visual verification when relevant → CI review → report evidence
```

Repository instructions follow Codex-style discovery: search for `AGENTS.override.md` and `AGENTS.md` from the repository root toward the target files. Instructions closer to a target file are more specific and override broader repository instructions; direct user/system instructions remain higher priority.

`safe_github_development` remains available for backwards compatibility. GitHub API writes still use managed `chatgpt/*` branches and Pull Requests rather than silently adopting a different Git workflow.

The workflow prefers `local_get_project_context`, `local_code_search`, and `local_git_review` over repeated shell/file calls when those tools can answer the question directly. `local_get_capabilities` should be checked before asking the user to perform a manual workaround.

### Read-only visual inspection

Visual access is deliberately **eyes without hands**:

- `local_get_ui_context` reads the frontmost application/bundle ID and a best-effort front-window title without activating or focusing an app.
- `local_capture_screen` captures one task-driven screenshot and returns an MCP image block, not merely a local path.
- screenshots are bounded by `LOCAL_AGENT_MAX_SCREENSHOT_BYTES` (default `1500000`) and `LOCAL_AGENT_SCREENSHOT_MAX_EDGE` (default `1600`); temporary files are deleted after each request.
- macOS Screen Recording permission is never bypassed. If capture is denied, the tool returns `screen_recording_permission_required`. Window-title metadata is best-effort and may be `null` when macOS denies access.
- the bridge does **not** add mouse clicks, keyboard typing, arbitrary UI automation, continuous screenshots, webcam access, microphone access, or background surveillance.

Prefer source code, DOM/structured data, terminal output, and logs when they provide more precise evidence than a screenshot.

## Requirements

Public gateway:

- Node.js 22+
- a GitHub App
- a public HTTPS URL reachable by ChatGPT

Optional Gmail mode:

- a Google Cloud project with the Gmail API enabled
- an OAuth client with access to `https://www.googleapis.com/auth/gmail.modify`
- one offline refresh token for the configured Gmail account

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
- Checks: **Read-only**
- Actions: **Read-only**
- Commit statuses: **Read-only**

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
LOCAL_AGENT_MAX_SCREENSHOT_BYTES=1500000
LOCAL_AGENT_SCREENSHOT_MAX_EDGE=1600

# Optional Gmail: configure all four together
GMAIL_CLIENT_ID=...
GMAIL_CLIENT_SECRET=...
GMAIL_REFRESH_TOKEN=...
GMAIL_ACCOUNT_EMAIL=you@example.com
```

If you only want GitHub mode, leave `LOCAL_AGENT_TOKEN` and all four Gmail variables empty.

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
- `gmail:read` when Gmail is configured
- `gmail:write` when Gmail is configured

If you deploy a version that adds tools/scopes after the app was already connected, refresh/reconnect the custom MCP app so ChatGPT discovers the new tool schema.


## 4. Add Gmail to the same MCP (optional)

Gmail runs in the public gateway, so these tools continue to work even when the Mac local agent is offline. The Google OAuth grant is separate from this bridge's ChatGPT-facing OAuth: ChatGPT receives the bridge scopes `gmail:read` / `gmail:write`, while the bridge itself receives Google's `gmail.modify` scope.

### Google Cloud setup

1. Create or select a Google Cloud project and enable the **Gmail API**.
2. Configure the OAuth audience as **External**. For a personal-use bridge, set publishing status to **In production**; Google's Testing status makes non-basic authorizations and their offline refresh tokens expire after seven days. Personal-use apps under Google's user cap can continue through the unverified-app warning without public verification.
3. Add exactly this data scope: `https://www.googleapis.com/auth/gmail.modify`.
4. Create an OAuth client that permits the loopback redirect `http://127.0.0.1:53682/callback`.

Run the one-time local authorization helper without pasting either Google secret into chat:

```bash
export GMAIL_CLIENT_ID='your-client-id'
export GMAIL_CLIENT_SECRET='your-client-secret'
npm run gmail:authorize
```

The helper opens Google authorization in the browser and writes the returned refresh token to:

```text
~/.config/chatgpt-gmail.env
```

That file is created with mode `0600`, and the helper never prints the refresh token. Configure Railway with `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`, and `GMAIL_ACCOUNT_EMAIL` as secrets, then redeploy. Do not commit the local token file.

After Gmail is configured, reconnect/re-authorize the custom MCP app so ChatGPT receives `gmail:read` and `gmail:write`, then verify `gmail_get_profile` before using the other Gmail tools.

## 5. Bootstrap the Mac local agent

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
LOCAL_AGENT_MAX_SCREENSHOT_BYTES=1500000
LOCAL_AGENT_SCREENSHOT_MAX_EDGE=1600
```

Lock it down:

```bash
chmod 600 ~/.config/chatgpt-local-agent.env
```

Run the agent in the foreground for the first test:

```bash
npm run local-agent
```

Then call `local_get_info` from ChatGPT. A successful response should show the Mac hostname, home directory, shell, Node version, and `connected: true`. `local_get_capabilities` reports which bridge features are usable with the caller's current MCP scopes; it deliberately reports Screen Recording permission as `unknown` until a task actually needs a capture.

The agent does not impose its own path sandbox, but macOS privacy/TCC controls still apply. If you want it to reach privacy-protected locations that macOS denies, grant the Node executable running the agent the corresponding macOS permission (for example Full Disk Access).

## 6. Install the Mac agent at login

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

## 7. What local execution can do

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

## 8. Git identity

When ChatGPT uses the Mac agent to run normal local Git commands, commits use the Git identity configured in that local repository/user environment:

```bash
git config user.name
git config user.email
```

That is different from commits created by the GitHub App API.

## 9. Security boundaries

GitHub mode remains conservative by default:

- explicit repository allowlist
- `chatgpt/*` branches
- PR-based writes
- no default-branch direct write
- no automatic merge unless enabled
- protected GitHub repository paths

Gmail mode is narrower than the local agent: Gmail access is account-pinned through `GMAIL_ACCOUNT_EMAIL`, uses only `gmail.modify`, has separate MCP read/write scopes, and v1 does not register trash or permanent-delete tools. Audit records omit message bodies, subjects, recipients, and search queries.

Local-agent mode is deliberately broader. The gateway only receives individual tool results; audit logs record tool metadata and sanitized errors, not file contents, shell output, terminal scrollback, environment values, or the local-agent token. The agent also removes its bridge credentials from child-process environments by default.

Screenshots are treated as sensitive task data. Capture is one-shot, temporary image files are deleted in `finally`, image bytes are returned only in the MCP image content block, and the base64 payload is not duplicated into `structuredContent`. Seeing a credential or personal information in a screenshot does not make it appropriate to echo it back.

Because the shell and filesystem are intentionally unrestricted, **user-readable secrets on the Mac are not a sandbox boundary**: a command that explicitly reads a credential file can still return that file's contents. Do not treat the local agent as a secret-isolation mechanism.

Rotate `LOCAL_AGENT_TOKEN` by changing it on both the gateway and Mac, then restart both sides.

## 10. Development

```bash
npm run typecheck
npm run test
npm run build
npm run check
```

Tests cover GitHub safety and CI reads, OAuth, Gmail token/MIME/API behavior, Gmail MCP scope enforcement and audit privacy, MCP tool registration and annotations, local gateway request correlation, project-context/code-search/Git-review behavior, bounded visual transport and permission handling, local filesystem/shell dispatch, and the Mac-agent request loop.

## 11. Hosting

The public gateway is host-agnostic. Railway works, but any provider that can keep a Node HTTPS service available long enough for MCP/OAuth requests and ~25-second long-poll requests can host it.

Moving providers only requires moving the gateway environment variables and changing `PUBLIC_BASE_URL` / `LOCAL_AGENT_GATEWAY_URL`.

## 12. Secrets

Never commit:

- `.env`
- GitHub App private keys
- OAuth store files
- audit logs
- `~/.config/chatgpt-local-agent.env`
- `~/.config/chatgpt-gmail.env`
- Google OAuth client secrets or Gmail refresh tokens
- `LOCAL_AGENT_TOKEN`

The repository's `.env.example` contains placeholders only.
