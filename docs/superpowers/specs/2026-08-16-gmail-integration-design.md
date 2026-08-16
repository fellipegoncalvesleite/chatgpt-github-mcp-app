# Gmail Integration Design

## Goal

Add Gmail as a first-class module inside the existing `Github_editor_v3` MCP service. Gmail tools must be exposed from the same MCP endpoint and OAuth connection as the existing GitHub and Mac tools; there is no second MCP service and no dependency on the Mac being online for Gmail access.

## Scope

V1 supports:

- get the authorized Gmail account profile
- search messages with normal Gmail search syntax
- read a message body and useful headers
- list labels
- list and read drafts
- create drafts
- send a new message
- send an existing draft
- archive messages by removing the `INBOX` label
- add/remove labels from messages

V1 intentionally does **not** expose:

- trash/untrash
- permanent message deletion
- permanent draft deletion
- Gmail settings changes
- filters, forwarding, delegates, POP/IMAP configuration
- attachment download/upload

## Architecture

The public Railway gateway owns Gmail API access. A new `GmailService` sits beside `GitHubService`, and `src/mcp.ts` registers Gmail tools alongside the existing `github_*` and `local_*` tools. Gmail calls therefore continue to work when the Mac local agent is offline.

The MCP's existing OAuth remains the authorization boundary between ChatGPT and this bridge. Two new bridge scopes are added:

- `gmail:read`
- `gmail:write`

Google OAuth is a separate upstream authorization between this bridge and the user's Google account. The bridge requests only:

`https://www.googleapis.com/auth/gmail.modify`

That scope is sufficient for reading messages, creating/sending mail, and changing labels, while avoiding the broader `https://mail.google.com/` scope. V1 also omits destructive Gmail tools even where the upstream scope could technically permit them.

## Google credentials and offline access

Gateway configuration uses four environment variables:

- `GMAIL_CLIENT_ID`
- `GMAIL_CLIENT_SECRET`
- `GMAIL_REFRESH_TOKEN`
- `GMAIL_ACCOUNT_EMAIL`

All four must either be configured together or omitted together. Partial Gmail configuration is a startup error.

The refresh token is obtained once through a small local authorization helper using Google's OAuth web-server flow with `access_type=offline`, `prompt=consent`, and the Gmail modify scope. The helper writes the refresh token to a local file with mode `0600`; it does not print the token into chat or commit it to the repository. The token is then configured as a secret in Railway.

For this personal-use bridge, the Google OAuth app should use an External audience with the publishing status set to **In production**. A Testing app would make non-basic OAuth grants, including refresh tokens, expire after seven days. Personal-use apps with fewer than 100 users can continue through Google's unverified-app warning without completing public app verification.

## Token handling

`GoogleTokenProvider` exchanges the configured refresh token at `https://oauth2.googleapis.com/token` and caches the resulting access token in memory until shortly before expiry. Access tokens and refresh tokens are never returned through MCP tool results or written to the audit log.

The service verifies the upstream account through Gmail's profile endpoint. If `GMAIL_ACCOUNT_EMAIL` does not match the authorized mailbox, Gmail tools fail closed with an account-mismatch error.

## Gmail API client

The integration uses Node 22's built-in `fetch` rather than adding the full Google API client dependency. This keeps the bridge small and makes the requested HTTP surface explicit.

`src/gmail/service.ts` owns:

- access-token refresh
- authenticated Gmail REST requests
- message search/read
- label operations
- draft operations
- send/archive/label mutations

`src/gmail/mime.ts` owns MIME composition and message-body extraction. Outgoing V1 messages are UTF-8 `text/plain` RFC 5322 messages encoded as Gmail-compatible base64url. Reading prefers `text/plain`; if a message has only HTML, the service returns the HTML body separately instead of attempting lossy HTML-to-text conversion.

## Tool surface

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

Tool schemas use Gmail message/draft/label IDs, never UI URLs or guessed IDs. Search results return bounded metadata (id, threadId, sender, recipients, subject, date, snippet, label IDs) and pagination tokens. Full bodies are fetched only by explicit read calls.

## Safety and audit behavior

Every Gmail tool goes through the existing `auditedTool` wrapper. Audit records contain the tool name, actor/client, outcome, and generic error code; they do not log message bodies, draft bodies, recipients, subjects, OAuth tokens, or Google credentials.

Read tools require `gmail:read`. Write tools require `gmail:write`. The MCP OAuth approval page already displays requested bridge scopes, so Gmail access becomes visible at connection approval time.

Bulk message mutation is capped at 100 message IDs per tool call. Search/list calls are capped at 100 results, with a default of 20.

## Errors

Upstream Gmail/Google OAuth failures are translated to `AppError` values:

- `gmail_not_configured`
- `gmail_auth_failed`
- `gmail_account_mismatch`
- `gmail_not_found`
- `gmail_rate_limited`
- `gmail_upstream_error`

Error results never include access tokens or raw OAuth responses. Gmail 401 triggers one forced token refresh/retry before failing. Gmail 429 preserves a safe retry-after hint when present.

## Testing

Tests inject a fake `fetch` implementation so no test touches a real Google account.

Coverage includes:

- partial configuration rejected
- bridge OAuth scopes include Gmail only when configured
- refresh-token exchange and access-token caching
- account mismatch fails closed
- Gmail search request shape and bounded result hydration
- body extraction from plain and multipart messages
- RFC 5322/base64url outgoing message composition
- draft creation and sending
- archive implemented only as removing `INBOX`
- label mutation request shape
- Gmail tools absent when unconfigured
- read/write bridge-scope enforcement
- audit logging without message content
- existing GitHub/local tests remain green

## Deployment

After merge:

1. Enable the Gmail API in a personal Google Cloud project.
2. Configure OAuth consent for External / In production and add the Gmail modify scope.
3. Create an OAuth client suitable for the local authorization helper and configure its loopback redirect URI.
4. Run `npm run gmail:authorize` locally to obtain the refresh token without exposing it in chat.
5. Add the four Gmail environment variables to Railway as secrets.
6. Redeploy the gateway.
7. Reconnect/re-authorize the custom MCP so ChatGPT receives `gmail:read` and `gmail:write` bridge scopes.
8. Verify `gmail_get_profile`, a search/read flow, draft creation, and a user-approved test send.
