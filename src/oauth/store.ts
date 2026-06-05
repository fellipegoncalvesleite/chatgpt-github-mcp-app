import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import { InvalidClientMetadataError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { sha256 } from "../utils.js";

export type StoredAuthorizationParams = {
  state?: string;
  scopes: string[];
  codeChallenge: string;
  redirectUri: string;
  resource?: string;
};

export type PendingAuthorization = {
  clientId: string;
  params: StoredAuthorizationParams;
  expiresAt: number;
};

export type AuthorizationCodeRecord = {
  clientId: string;
  params: StoredAuthorizationParams;
  expiresAt: number;
};

export type RefreshTokenRecord = {
  clientId: string;
  scopes: string[];
  resource: string;
  expiresAt: number;
};

type OAuthStoreData = {
  clients: Record<string, OAuthClientInformationFull>;
  pending: Record<string, PendingAuthorization>;
  codes: Record<string, AuthorizationCodeRecord>;
  refreshTokens: Record<string, RefreshTokenRecord>;
};

const EMPTY: OAuthStoreData = { clients: {}, pending: {}, codes: {}, refreshTokens: {} };

export class JsonOAuthStore implements OAuthRegisteredClientsStore {
  private data: OAuthStoreData = structuredClone(EMPTY);
  private initialized = false;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly path: string,
    private readonly allowedRedirectHosts: string[],
  ) {}

  private async init(): Promise<void> {
    if (this.initialized) return;
    try {
      const raw = await readFile(this.path, "utf8");
      this.data = JSON.parse(raw) as OAuthStoreData;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      this.data = structuredClone(EMPTY);
    }
    this.initialized = true;
    await this.cleanup();
  }

  private isRedirectAllowed(uri: string): boolean {
    let url: URL;
    try {
      url = new URL(uri);
    } catch {
      return false;
    }
    const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
    if (!loopback && url.protocol !== "https:") return false;
    return this.allowedRedirectHosts.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temp = `${this.path}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(this.data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temp, this.path);
  }

  private async mutate<T>(callback: () => T | Promise<T>): Promise<T> {
    await this.init();
    let output!: T;
    this.queue = this.queue.then(async () => {
      output = await callback();
      await this.persist();
    });
    await this.queue;
    return output;
  }

  async cleanup(): Promise<void> {
    const now = Date.now();
    let changed = false;
    for (const bucket of [this.data.pending, this.data.codes, this.data.refreshTokens]) {
      for (const [key, value] of Object.entries(bucket)) {
        if (value.expiresAt <= now) {
          delete bucket[key];
          changed = true;
        }
      }
    }
    if (changed && this.initialized) await this.persist();
  }

  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    await this.init();
    return this.data.clients[clientId];
  }

  async registerClient(client: OAuthClientInformationFull): Promise<OAuthClientInformationFull> {
    if (!client.redirect_uris.every((uri) => this.isRedirectAllowed(uri))) {
      throw new InvalidClientMetadataError("One or more redirect_uris use an unapproved host");
    }
    if (client.token_endpoint_auth_method && client.token_endpoint_auth_method !== "none") {
      throw new InvalidClientMetadataError("Only public OAuth clients using token_endpoint_auth_method=none are accepted");
    }
    return this.mutate(() => {
      this.data.clients[client.client_id] = client;
      return client;
    });
  }

  async putPending(id: string, record: PendingAuthorization): Promise<void> {
    await this.mutate(() => { this.data.pending[sha256(id)] = record; });
  }

  async takePending(id: string): Promise<PendingAuthorization | undefined> {
    return this.mutate(() => {
      const key = sha256(id);
      const record = this.data.pending[key];
      delete this.data.pending[key];
      return record;
    });
  }

  async getPending(id: string): Promise<PendingAuthorization | undefined> {
    await this.init();
    return this.data.pending[sha256(id)];
  }

  async putCode(code: string, record: AuthorizationCodeRecord): Promise<void> {
    await this.mutate(() => { this.data.codes[sha256(code)] = record; });
  }

  async getCode(code: string): Promise<AuthorizationCodeRecord | undefined> {
    await this.init();
    return this.data.codes[sha256(code)];
  }

  async takeCode(code: string): Promise<AuthorizationCodeRecord | undefined> {
    return this.mutate(() => {
      const key = sha256(code);
      const record = this.data.codes[key];
      delete this.data.codes[key];
      return record;
    });
  }

  async putRefreshToken(token: string, record: RefreshTokenRecord): Promise<void> {
    await this.mutate(() => { this.data.refreshTokens[sha256(token)] = record; });
  }

  async takeRefreshToken(token: string): Promise<RefreshTokenRecord | undefined> {
    return this.mutate(() => {
      const key = sha256(token);
      const record = this.data.refreshTokens[key];
      delete this.data.refreshTokens[key];
      return record;
    });
  }

  async revokeRefreshToken(token: string): Promise<void> {
    await this.mutate(() => { delete this.data.refreshTokens[sha256(token)]; });
  }
}
