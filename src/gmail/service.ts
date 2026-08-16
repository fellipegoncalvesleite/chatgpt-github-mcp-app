import { AppError } from "../errors.js";
import {
  composeTextMessage,
  extractMessageView,
  type ComposeTextMessageInput,
  type GmailApiMessage,
  type GmailMessageView,
} from "./mime.js";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

export type GmailProfile = {
  emailAddress: string;
  messagesTotal?: number;
  threadsTotal?: number;
  historyId?: string;
};

export type GmailLabelView = {
  id: string;
  name: string;
  type: string;
};

export type GmailDraftView = {
  id: string;
  message: GmailMessageView;
};

export type GmailDraftSummary = {
  id: string;
  messageId: string;
  threadId: string;
};

export type GmailSearchResult = {
  messages: GmailMessageView[];
  nextPageToken: string;
  resultSizeEstimate: number;
};

export type GmailDraftListResult = {
  drafts: GmailDraftSummary[];
  nextPageToken: string;
  resultSizeEstimate: number;
};

export type GmailSendResult = {
  id: string;
  threadId: string;
  labelIds: string[];
};

export type AccessTokenProvider = {
  getAccessToken(forceRefresh?: boolean): Promise<string>;
};

type FetchLike = typeof fetch;

type GoogleTokenProviderOptions = {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  fetchImpl?: FetchLike;
  now?: () => number;
};

export class GoogleTokenProvider implements AccessTokenProvider {
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private cached?: { token: string; expiresAt: number };

  constructor(private readonly options: GoogleTokenProviderOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async getAccessToken(forceRefresh = false): Promise<string> {
    if (!forceRefresh && this.cached && this.now() < this.cached.expiresAt - 60_000) {
      return this.cached.token;
    }

    const body = new URLSearchParams({
      client_id: this.options.clientId,
      client_secret: this.options.clientSecret,
      refresh_token: this.options.refreshToken,
      grant_type: "refresh_token",
    });
    let response: Response;
    try {
      response = await this.fetchImpl(GOOGLE_TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      });
    } catch {
      throw new AppError("gmail_auth_failed", "Could not reach Google OAuth token service", 502);
    }
    if (!response.ok) {
      throw new AppError("gmail_auth_failed", "Google rejected the configured Gmail authorization", 401);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new AppError("gmail_auth_failed", "Google OAuth returned an invalid token response", 502);
    }
    const record = payload as { access_token?: unknown; expires_in?: unknown };
    if (typeof record.access_token !== "string" || !record.access_token) {
      throw new AppError("gmail_auth_failed", "Google OAuth did not return an access token", 502);
    }
    const expiresIn = typeof record.expires_in === "number" && Number.isFinite(record.expires_in)
      ? Math.max(60, record.expires_in)
      : 3600;
    this.cached = { token: record.access_token, expiresAt: this.now() + expiresIn * 1000 };
    return record.access_token;
  }
}

type GmailServiceOptions = {
  accountEmail: string;
  tokenProvider: AccessTokenProvider;
  fetchImpl?: FetchLike;
};

type ListMessageResponse = {
  messages?: Array<{ id?: string; threadId?: string }>;
  nextPageToken?: string;
  resultSizeEstimate?: number;
};

type ListDraftResponse = {
  drafts?: Array<{ id?: string; message?: { id?: string; threadId?: string } }>;
  nextPageToken?: string;
  resultSizeEstimate?: number;
};

type ApiDraft = {
  id?: string;
  message?: GmailApiMessage;
};

function boundedMaxResults(value: number | undefined): number {
  if (value === undefined) return 20;
  return Math.max(1, Math.min(100, Math.floor(value)));
}

function assertBoundedIds(ids: string[], kind: string): string[] {
  if (ids.length < 1 || ids.length > 100) {
    throw new AppError("gmail_invalid_input", `${kind} must contain between 1 and 100 IDs`, 400);
  }
  const normalized = ids.map((id) => id.trim());
  if (normalized.some((id) => !id)) throw new AppError("gmail_invalid_input", `${kind} contains an empty ID`, 400);
  return [...new Set(normalized)];
}

function safeLabelIds(ids: string[]): string[] {
  const normalized = ids.map((id) => id.trim()).filter(Boolean);
  if (normalized.some((id) => id.toUpperCase() === "TRASH")) {
    throw new AppError("gmail_forbidden_label", "TRASH changes are not exposed by Gmail v1 tools", 403);
  }
  return [...new Set(normalized)];
}

export class GmailService {
  private readonly fetchImpl: FetchLike;
  private verifiedProfile?: GmailProfile;

  constructor(private readonly options: GmailServiceOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async request<T>(path: string, init: RequestInit = {}, retry401 = true): Promise<T> {
    const token = await this.options.tokenProvider.getAccessToken(false);
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${token}`);
    if (init.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");

    let response: Response;
    try {
      response = await this.fetchImpl(`${GMAIL_API_BASE}${path}`, { ...init, headers });
    } catch {
      throw new AppError("gmail_upstream_error", "Could not reach the Gmail API", 502);
    }

    if (response.status === 401 && retry401) {
      const freshToken = await this.options.tokenProvider.getAccessToken(true);
      const retryHeaders = new Headers(init.headers);
      retryHeaders.set("authorization", `Bearer ${freshToken}`);
      if (init.body !== undefined && !retryHeaders.has("content-type")) retryHeaders.set("content-type", "application/json");
      try {
        response = await this.fetchImpl(`${GMAIL_API_BASE}${path}`, { ...init, headers: retryHeaders });
      } catch {
        throw new AppError("gmail_upstream_error", "Could not reach the Gmail API", 502);
      }
    }

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new AppError("gmail_auth_failed", "Gmail rejected the configured authorization", 401);
      }
      if (response.status === 404) throw new AppError("gmail_not_found", "Gmail resource was not found", 404);
      if (response.status === 429) {
        const retryAfter = response.headers.get("retry-after") ?? undefined;
        throw new AppError("gmail_rate_limited", "Gmail rate limit reached", 429, retryAfter ? { retryAfter } : undefined);
      }
      throw new AppError("gmail_upstream_error", `Gmail API request failed with status ${response.status}`, 502);
    }

    if (response.status === 204) return undefined as T;
    const text = await response.text();
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new AppError("gmail_upstream_error", "Gmail API returned invalid JSON", 502);
    }
  }

  private async ensureAccount(): Promise<GmailProfile> {
    if (this.verifiedProfile) return this.verifiedProfile;
    const profile = await this.request<GmailProfile>("/profile");
    if (profile.emailAddress.toLowerCase() !== this.options.accountEmail.trim().toLowerCase()) {
      throw new AppError(
        "gmail_account_mismatch",
        "The authorized Gmail mailbox does not match GMAIL_ACCOUNT_EMAIL",
        403,
      );
    }
    this.verifiedProfile = profile;
    return profile;
  }

  async getProfile(): Promise<GmailProfile> {
    return await this.ensureAccount();
  }

  private async readMessageMetadata(messageId: string): Promise<GmailMessageView> {
    const params = new URLSearchParams({ format: "metadata" });
    for (const name of ["From", "To", "Cc", "Bcc", "Subject", "Date", "Message-ID"]) {
      params.append("metadataHeaders", name);
    }
    const message = await this.request<GmailApiMessage>(`/messages/${encodeURIComponent(messageId)}?${params.toString()}`);
    return extractMessageView(message);
  }

  async searchMessages(input: { query?: string | undefined; maxResults?: number | undefined; pageToken?: string | undefined }): Promise<GmailSearchResult> {
    await this.ensureAccount();
    const params = new URLSearchParams({ maxResults: String(boundedMaxResults(input.maxResults)) });
    if (input.query) params.set("q", input.query);
    if (input.pageToken) params.set("pageToken", input.pageToken);
    const listed = await this.request<ListMessageResponse>(`/messages?${params.toString()}`);
    const ids = (listed.messages ?? []).flatMap((message) => typeof message.id === "string" && message.id ? [message.id] : []);
    const messages = await Promise.all(ids.map((id) => this.readMessageMetadata(id)));
    return {
      messages,
      nextPageToken: listed.nextPageToken ?? "",
      resultSizeEstimate: listed.resultSizeEstimate ?? messages.length,
    };
  }

  async readMessage(messageId: string): Promise<GmailMessageView> {
    await this.ensureAccount();
    const message = await this.request<GmailApiMessage>(`/messages/${encodeURIComponent(messageId)}?format=full`);
    return extractMessageView(message);
  }

  async listLabels(): Promise<GmailLabelView[]> {
    await this.ensureAccount();
    const result = await this.request<{ labels?: Array<{ id?: string; name?: string; type?: string }> }>("/labels");
    return (result.labels ?? []).flatMap((label) => {
      if (!label.id || !label.name) return [];
      return [{ id: label.id, name: label.name, type: label.type ?? "" }];
    });
  }

  async listDrafts(input: { query?: string | undefined; maxResults?: number | undefined; pageToken?: string | undefined }): Promise<GmailDraftListResult> {
    await this.ensureAccount();
    const params = new URLSearchParams({ maxResults: String(boundedMaxResults(input.maxResults)) });
    if (input.query) params.set("q", input.query);
    if (input.pageToken) params.set("pageToken", input.pageToken);
    const result = await this.request<ListDraftResponse>(`/drafts?${params.toString()}`);
    const drafts = (result.drafts ?? []).flatMap((draft) => {
      if (!draft.id) return [];
      return [{ id: draft.id, messageId: draft.message?.id ?? "", threadId: draft.message?.threadId ?? "" }];
    });
    return {
      drafts,
      nextPageToken: result.nextPageToken ?? "",
      resultSizeEstimate: result.resultSizeEstimate ?? drafts.length,
    };
  }

  async readDraft(draftId: string): Promise<GmailDraftView> {
    await this.ensureAccount();
    const draft = await this.request<ApiDraft>(`/drafts/${encodeURIComponent(draftId)}?format=full`);
    return { id: draft.id ?? draftId, message: extractMessageView(draft.message ?? {}) };
  }

  async createDraft(input: ComposeTextMessageInput): Promise<GmailDraftSummary> {
    await this.ensureAccount();
    const raw = composeTextMessage(input);
    const draft = await this.request<ApiDraft>("/drafts", {
      method: "POST",
      body: JSON.stringify({ message: { raw } }),
    });
    return { id: draft.id ?? "", messageId: draft.message?.id ?? "", threadId: draft.message?.threadId ?? "" };
  }

  async sendMessage(input: ComposeTextMessageInput): Promise<GmailSendResult> {
    await this.ensureAccount();
    const raw = composeTextMessage(input);
    const message = await this.request<GmailApiMessage>("/messages/send", {
      method: "POST",
      body: JSON.stringify({ raw }),
    });
    return { id: message.id ?? "", threadId: message.threadId ?? "", labelIds: message.labelIds ?? [] };
  }

  async sendDraft(draftId: string): Promise<GmailSendResult> {
    await this.ensureAccount();
    const message = await this.request<GmailApiMessage>("/drafts/send", {
      method: "POST",
      body: JSON.stringify({ id: draftId }),
    });
    return { id: message.id ?? "", threadId: message.threadId ?? "", labelIds: message.labelIds ?? [] };
  }

  async archiveMessages(messageIds: string[]): Promise<{ archived: number }> {
    await this.ensureAccount();
    const ids = assertBoundedIds(messageIds, "messageIds");
    await this.request<void>("/messages/batchModify", {
      method: "POST",
      body: JSON.stringify({ ids, removeLabelIds: ["INBOX"] }),
    });
    return { archived: ids.length };
  }

  async modifyLabels(messageIds: string[], addLabelIds: string[], removeLabelIds: string[]): Promise<{ modified: number }> {
    const ids = assertBoundedIds(messageIds, "messageIds");
    const add = safeLabelIds(addLabelIds);
    const remove = safeLabelIds(removeLabelIds);
    if (add.length === 0 && remove.length === 0) {
      throw new AppError("gmail_invalid_input", "At least one label must be added or removed", 400);
    }
    await this.ensureAccount();
    await this.request<void>("/messages/batchModify", {
      method: "POST",
      body: JSON.stringify({
        ids,
        ...(add.length ? { addLabelIds: add } : {}),
        ...(remove.length ? { removeLabelIds: remove } : {}),
      }),
    });
    return { modified: ids.length };
  }
}
