import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { z } from "zod/v4";
import type { AuditLogger } from "../audit.js";
import { AppError, toErrorMessage } from "../errors.js";
import type { GmailService } from "./service.js";

export type GmailToolService = Pick<
  GmailService,
  | "getProfile"
  | "searchMessages"
  | "readMessage"
  | "listLabels"
  | "listDrafts"
  | "readDraft"
  | "createDraft"
  | "sendMessage"
  | "sendDraft"
  | "archiveMessages"
  | "modifyLabels"
>;

type ToolExtra = { authInfo?: AuthInfo };
type GmailScope = "gmail:read" | "gmail:write";

function requireGmailScope(extra: ToolExtra, scope: GmailScope): void {
  const scopes = extra.authInfo?.scopes ?? [];
  if (!scopes.includes(scope)) {
    throw new AppError("insufficient_scope", `This tool requires OAuth scope ${scope}`, 403, { requiredScope: scope });
  }
}

function actorFrom(extra: ToolExtra): { actor?: string; clientId?: string } {
  const subject = extra.authInfo?.extra?.subject;
  return {
    ...(typeof subject === "string" ? { actor: subject } : {}),
    ...(extra.authInfo?.clientId ? { clientId: extra.authInfo.clientId } : {}),
  };
}

function successResult(value: unknown) {
  const structuredContent = Array.isArray(value)
    ? { items: value }
    : typeof value === "object" && value !== null
      ? value as Record<string, unknown>
      : { value };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent,
  };
}

function errorResult(error: unknown) {
  const appError = error instanceof AppError
    ? error
    : new AppError("internal_error", "Unexpected Gmail tool failure", 500);
  return {
    isError: true,
    content: [{ type: "text" as const, text: `${appError.code}: ${appError.message}` }],
    structuredContent: {
      error: appError.code,
      message: appError.message,
      ...(appError.details === undefined ? {} : { details: appError.details }),
    },
  };
}

async function gmailTool(
  audit: AuditLogger,
  tool: string,
  extra: ToolExtra,
  action: () => Promise<unknown>,
  safeDetails: Record<string, unknown> = {},
) {
  try {
    const result = await action();
    await audit.write({
      ...actorFrom(extra),
      tool,
      outcome: "success",
      ...(Object.keys(safeDetails).length ? { details: safeDetails } : {}),
    });
    return successResult(result);
  } catch (error) {
    const denied = error instanceof AppError && error.status >= 400 && error.status < 500;
    await audit.write({
      ...actorFrom(extra),
      tool,
      outcome: denied ? "denied" : "error",
      details: {
        ...safeDetails,
        code: error instanceof AppError ? error.code : "internal_error",
        message: error instanceof AppError ? error.message : "Unexpected Gmail tool failure",
      },
    });
    return errorResult(error);
  }
}

const gmailIdSchema = z.string().min(1).max(512).describe("Gmail resource ID returned by another Gmail tool");
const messageIdsSchema = z.array(gmailIdSchema).min(1).max(100).describe("One to 100 Gmail message IDs");
const labelIdsSchema = z.array(gmailIdSchema).max(100).default([]).describe("Gmail label IDs returned by gmail_list_labels");
const recipientSchema = z.string().min(1).max(1_000).refine((value) => !/[\r\n]/.test(value), "Recipient must not contain line breaks");

const composeSchema = z.object({
  to: z.array(recipientSchema).min(1).max(50),
  cc: z.array(recipientSchema).max(50).optional(),
  bcc: z.array(recipientSchema).max(50).optional(),
  subject: z.string().max(998).refine((value) => !/[\r\n]/.test(value), "Subject must not contain line breaks"),
  bodyText: z.string().max(1_000_000),
});

export function registerGmailTools(
  server: McpServer,
  dependencies: { gmail: GmailToolService; audit: AuditLogger },
): void {
  const { gmail, audit } = dependencies;

  server.registerTool(
    "gmail_get_profile",
    {
      title: "Get Gmail profile",
      description: "Get the authorized Gmail mailbox profile and verify that it matches the configured Gmail account.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (_input, extra) => gmailTool(audit, "gmail_get_profile", extra, async () => {
      requireGmailScope(extra, "gmail:read");
      return await gmail.getProfile();
    }),
  );

  server.registerTool(
    "gmail_search_messages",
    {
      title: "Search Gmail messages",
      description: "Search Gmail with normal Gmail search syntax and return bounded message metadata. Use gmail_read_message for full bodies.",
      inputSchema: z.object({
        query: z.string().max(2_000).optional().describe("Gmail search query, e.g. from:alice@example.com newer_than:7d"),
        maxResults: z.number().int().min(1).max(100).default(20),
        pageToken: z.string().min(1).max(2_000).optional(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (input, extra) => gmailTool(audit, "gmail_search_messages", extra, async () => {
      requireGmailScope(extra, "gmail:read");
      return await gmail.searchMessages(input);
    }, { maxResults: input.maxResults }),
  );

  server.registerTool(
    "gmail_read_message",
    {
      title: "Read Gmail message",
      description: "Read one Gmail message by message ID, including headers and available plain-text/HTML body content.",
      inputSchema: z.object({ messageId: gmailIdSchema }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ messageId }, extra) => gmailTool(audit, "gmail_read_message", extra, async () => {
      requireGmailScope(extra, "gmail:read");
      return await gmail.readMessage(messageId);
    }),
  );

  server.registerTool(
    "gmail_list_labels",
    {
      title: "List Gmail labels",
      description: "List Gmail system and user labels with their IDs for use in label operations.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (_input, extra) => gmailTool(audit, "gmail_list_labels", extra, async () => {
      requireGmailScope(extra, "gmail:read");
      return await gmail.listLabels();
    }),
  );

  server.registerTool(
    "gmail_list_drafts",
    {
      title: "List Gmail drafts",
      description: "List Gmail draft IDs, optionally filtered with Gmail query syntax. Use gmail_read_draft for full content.",
      inputSchema: z.object({
        query: z.string().max(2_000).optional(),
        maxResults: z.number().int().min(1).max(100).default(20),
        pageToken: z.string().min(1).max(2_000).optional(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (input, extra) => gmailTool(audit, "gmail_list_drafts", extra, async () => {
      requireGmailScope(extra, "gmail:read");
      return await gmail.listDrafts(input);
    }, { maxResults: input.maxResults }),
  );

  server.registerTool(
    "gmail_read_draft",
    {
      title: "Read Gmail draft",
      description: "Read one Gmail draft by draft ID, including its message headers and body.",
      inputSchema: z.object({ draftId: gmailIdSchema }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ draftId }, extra) => gmailTool(audit, "gmail_read_draft", extra, async () => {
      requireGmailScope(extra, "gmail:read");
      return await gmail.readDraft(draftId);
    }),
  );

  server.registerTool(
    "gmail_create_draft",
    {
      title: "Create Gmail draft",
      description: "Create a text-only Gmail draft. This does not send the message.",
      inputSchema: composeSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (input, extra) => gmailTool(audit, "gmail_create_draft", extra, async () => {
      requireGmailScope(extra, "gmail:write");
      return await gmail.createDraft(input);
    }, { recipientCount: input.to.length + (input.cc?.length ?? 0) + (input.bcc?.length ?? 0) }),
  );

  server.registerTool(
    "gmail_send_message",
    {
      title: "Send Gmail message",
      description: "Send a text-only email from the configured Gmail account.",
      inputSchema: composeSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (input, extra) => gmailTool(audit, "gmail_send_message", extra, async () => {
      requireGmailScope(extra, "gmail:write");
      return await gmail.sendMessage(input);
    }, { recipientCount: input.to.length + (input.cc?.length ?? 0) + (input.bcc?.length ?? 0) }),
  );

  server.registerTool(
    "gmail_send_draft",
    {
      title: "Send Gmail draft",
      description: "Send an existing Gmail draft by draft ID.",
      inputSchema: z.object({ draftId: gmailIdSchema }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ draftId }, extra) => gmailTool(audit, "gmail_send_draft", extra, async () => {
      requireGmailScope(extra, "gmail:write");
      return await gmail.sendDraft(draftId);
    }),
  );

  server.registerTool(
    "gmail_archive_messages",
    {
      title: "Archive Gmail messages",
      description: "Archive one to 100 Gmail messages by removing the INBOX label. This does not trash or delete messages.",
      inputSchema: z.object({ messageIds: messageIdsSchema }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ messageIds }, extra) => gmailTool(audit, "gmail_archive_messages", extra, async () => {
      requireGmailScope(extra, "gmail:write");
      return await gmail.archiveMessages(messageIds);
    }, { messageCount: messageIds.length }),
  );

  server.registerTool(
    "gmail_modify_labels",
    {
      title: "Modify Gmail message labels",
      description: "Add or remove Gmail labels on one to 100 messages. TRASH manipulation is blocked in v1.",
      inputSchema: z.object({
        messageIds: messageIdsSchema,
        addLabelIds: labelIdsSchema,
        removeLabelIds: labelIdsSchema,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ messageIds, addLabelIds, removeLabelIds }, extra) => gmailTool(audit, "gmail_modify_labels", extra, async () => {
      requireGmailScope(extra, "gmail:write");
      return await gmail.modifyLabels(messageIds, addLabelIds, removeLabelIds);
    }, { messageCount: messageIds.length, addLabelCount: addLabelIds.length, removeLabelCount: removeLabelIds.length }),
  );
}
