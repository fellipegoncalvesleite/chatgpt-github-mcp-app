# Gmail Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Gmail read/search/draft/send/archive/label capabilities to the existing `Github_editor_v3` MCP, hosted on the public gateway and usable independently of the Mac local agent.

**Architecture:** Add gateway-side Google token and Gmail REST services, then register Gmail tools in the existing MCP server behind new `gmail:read` and `gmail:write` bridge scopes. Google credentials remain environment secrets, while a local helper performs the one-time offline OAuth grant and stores the refresh token outside the repository.

**Tech Stack:** Node.js 22 built-in `fetch`, TypeScript 6, Zod 4, MCP SDK 1.29, Express 5, Vitest 4, Gmail REST API, Google OAuth 2.0.

## Global Constraints

- Gmail is part of the same `Github_editor_v3` MCP endpoint; no second MCP service.
- Gmail runs on the public gateway and does not depend on the Mac local agent.
- Google upstream scope is exactly `https://www.googleapis.com/auth/gmail.modify` for v1.
- Bridge scopes are `gmail:read` and `gmail:write`.
- No trash/untrash or permanent delete tools in v1.
- No message bodies, recipients, subjects, or OAuth credentials in audit logs.
- Search/list default is 20 and maximum is 100.
- Bulk message mutation maximum is 100 IDs.
- All four Gmail config values are configured together or Gmail is fully disabled.

---

### Task 1: Gmail configuration and bridge scopes

**Files:**
- Modify: `src/config.ts`
- Modify: `src/oauth/provider.ts`
- Modify: `.env.example`
- Test: `tests/http.test.ts`

**Interfaces:**
- Produces config fields `gmailClientId`, `gmailClientSecret`, `gmailRefreshToken`, `gmailAccountEmail`, and derived helper `gmailConfigured(config)`.
- Extends `OAUTH_SCOPES` with `gmail:read` and `gmail:write`.

- [ ] **Step 1: Write failing configuration/scope tests**

Add cases proving all-empty Gmail config is accepted, all-four values enable Gmail scopes, and partial config throws during `loadConfig`.

- [ ] **Step 2: Run the focused tests and confirm failure**

Run: `npm test -- tests/http.test.ts`
Expected: FAIL because Gmail config fields/scopes do not exist.

- [ ] **Step 3: Implement minimal config and OAuth-scope support**

Add the four string fields, validate all-or-none configuration, export `gmailConfigured`, append Gmail scopes to `OAUTH_SCOPES`, and add configured Gmail scopes to initial default grants without changing non-Gmail deployments.

- [ ] **Step 4: Update `.env.example`**

Document only placeholders; never include real Google credentials.

- [ ] **Step 5: Run focused tests**

Run: `npm test -- tests/http.test.ts`
Expected: PASS.

### Task 2: MIME helpers and Gmail REST service

**Files:**
- Create: `src/gmail/mime.ts`
- Create: `src/gmail/service.ts`
- Create: `tests/gmail-service.test.ts`

**Interfaces:**
- `composeTextMessage(input): string` returns Gmail base64url RFC 5322 raw content.
- `extractMessageView(message): GmailMessageView` returns bounded headers/body metadata.
- `GoogleTokenProvider.getAccessToken(forceRefresh?: boolean): Promise<string>`.
- `GmailService` exposes profile/search/read/labels/drafts/send/archive/modify methods.

- [ ] **Step 1: Write failing MIME tests**

Test UTF-8 subject/body composition, base64url encoding, To/Cc/Bcc headers, and plain/multipart body extraction.

- [ ] **Step 2: Run tests and confirm failure**

Run: `npm test -- tests/gmail-service.test.ts`
Expected: FAIL because Gmail modules do not exist.

- [ ] **Step 3: Implement MIME helpers**

Use Node `Buffer` only; outgoing content is `text/plain; charset=UTF-8` with CRLF line endings and base64url output.

- [ ] **Step 4: Add failing token/service tests**

Mock `fetch` to cover refresh exchange, token caching, forced refresh on Gmail 401, account mismatch, search hydration, read, label listing, draft creation/list/read/send, direct send, archive, and label modification.

- [ ] **Step 5: Implement `GoogleTokenProvider` and `GmailService`**

Use `https://oauth2.googleapis.com/token` and `https://gmail.googleapis.com/gmail/v1/users/me/...`. Translate upstream failures to safe `AppError` codes and never include secrets in error text.

- [ ] **Step 6: Run Gmail service tests**

Run: `npm test -- tests/gmail-service.test.ts`
Expected: PASS.

### Task 3: Register Gmail tools inside the existing MCP

**Files:**
- Modify: `src/mcp.ts`
- Modify: `src/server.ts`
- Create: `src/gmail/mcp-tools.ts`
- Modify: `tests/mcp.test.ts`
- Test: `tests/gmail-mcp.test.ts`

**Interfaces:**
- `registerGmailTools(server, { gmail, audit }): void`
- `createGitHubMcpServer` accepts optional `gmail?: GmailToolService`.
- `AppDependencies` accepts optional Gmail service; default dependencies create it only when configured.

- [ ] **Step 1: Write failing tool-registration and scope tests**

Verify Gmail tools are absent when Gmail is unconfigured, present when configured, read tools reject tokens without `gmail:read`, and write tools reject tokens without `gmail:write`.

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `npm test -- tests/mcp.test.ts tests/gmail-mcp.test.ts`
Expected: FAIL because Gmail tools are not registered.

- [ ] **Step 3: Implement `registerGmailTools`**

Register exactly the eleven v1 tools from the design. Apply bounded Zod schemas, MCP read/write annotations, and the existing audit wrapper without logging mail content.

- [ ] **Step 4: Wire Gmail into server dependencies**

Instantiate `GoogleTokenProvider` and `GmailService` only when all Gmail credentials exist. Update MCP server instructions to mention Gmail and prohibit exposing Google credentials.

- [ ] **Step 5: Run focused MCP tests**

Run: `npm test -- tests/mcp.test.ts tests/gmail-mcp.test.ts`
Expected: PASS.

### Task 4: Safe one-time Google authorization helper

**Files:**
- Create: `scripts/gmail-authorize.mjs`
- Modify: `package.json`
- Modify: `README.md`
- Test: `tests/gmail-authorize.test.ts`

**Interfaces:**
- `npm run gmail:authorize` obtains an offline refresh token for `gmail.modify`.
- Default output file: `~/.config/chatgpt-gmail.env`, mode `0600`.

- [ ] **Step 1: Write failing tests for authorization URL and token-file behavior**

Test `access_type=offline`, `prompt=consent`, exact Gmail scope, loopback redirect, no token written to stdout, and file mode `0600`.

- [ ] **Step 2: Run focused test and confirm failure**

Run: `npm test -- tests/gmail-authorize.test.ts`
Expected: FAIL because helper does not exist.

- [ ] **Step 3: Implement the helper**

Use Node HTTP and built-ins only. Read client ID/secret from environment, open Google's consent URL on macOS, receive the loopback callback, exchange the code, write only `GMAIL_REFRESH_TOKEN=...` to the protected local file, and print the path plus a masked success message.

- [ ] **Step 4: Document Google Cloud/Railway setup**

Document Gmail API enablement, personal-use External/In-production consent configuration, OAuth client redirect, four Railway secrets, redeploy, and MCP reauthorization. Explicitly warn that Testing status causes non-basic grants/refresh tokens to expire after seven days.

- [ ] **Step 5: Run focused tests**

Run: `npm test -- tests/gmail-authorize.test.ts`
Expected: PASS.

### Task 5: Full verification and release integration

**Files:**
- Verify all modified files

**Interfaces:**
- No new interface; this task proves repository-wide compatibility.

- [ ] **Step 1: Run complete checks**

Run: `npm run check`
Expected: typecheck PASS, all Vitest tests PASS, production build PASS.

- [ ] **Step 2: Run secret/stale-scope scan**

Run: `git grep -n -E 'GMAIL_(CLIENT_ID|CLIENT_SECRET|REFRESH_TOKEN)=' -- ':!.env.example' ':!README.md' || true`
Expected: no committed real credential values or generated Gmail env files.

- [ ] **Step 3: Review diff and status**

Run: `git diff --check && git status --short`
Expected: no whitespace errors and only intended feature files changed.

- [ ] **Step 4: Commit feature branch**

Commit the verified Gmail integration as one cohesive feature commit (documentation/spec commits may remain separate on the branch). Push `chatgpt/gmail-integration` and merge only after the final verification evidence is fresh.
