import { scryptSync, timingSafeEqual } from "node:crypto";
import type { Response } from "express";
import { SignJWT, jwtVerify } from "jose";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import {
  AccessDeniedError,
  InvalidGrantError,
  InvalidScopeError,
  InvalidTargetError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AppConfig } from "../config.js";
import { htmlEscape, randomToken } from "../utils.js";
import { JsonOAuthStore, type StoredAuthorizationParams } from "./store.js";

export const OAUTH_SCOPES = ["github:read", "github:write", "github:merge"] as const;

export class SingleUserOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: JsonOAuthStore;
  private readonly signingKey: Uint8Array;
  private readonly issuer: URL;
  private readonly resource: URL;

  constructor(private readonly config: AppConfig) {
    this.clientsStore = new JsonOAuthStore(config.oauthStorePath, config.oauthAllowedRedirectHosts);
    this.signingKey = new TextEncoder().encode(config.oauthSigningSecret);
    this.issuer = new URL("/", config.publicBaseUrl);
    this.resource = new URL("/mcp", config.publicBaseUrl);
  }

  private validateResource(resource?: URL): URL {
    const actual = resource ?? this.resource;
    if (actual.href !== this.resource.href) {
      throw new InvalidTargetError(`Expected resource ${this.resource.href}`);
    }
    return actual;
  }

  private validateScopes(scopes: string[] | undefined): string[] {
    const requested = scopes?.length ? [...new Set(scopes)] : ["github:read", "github:write"];
    if (requested.some((scope) => !OAUTH_SCOPES.includes(scope as (typeof OAUTH_SCOPES)[number]))) {
      throw new InvalidScopeError("Unsupported OAuth scope requested");
    }
    if (requested.includes("github:merge") && !this.config.allowMerge) {
      throw new InvalidScopeError("github:merge is unavailable because ALLOW_MERGE=false");
    }
    return requested;
  }

  private storedParams(params: AuthorizationParams): StoredAuthorizationParams {
    return {
      ...(params.state === undefined ? {} : { state: params.state }),
      scopes: this.validateScopes(params.scopes),
      codeChallenge: params.codeChallenge,
      redirectUri: params.redirectUri,
      resource: this.validateResource(params.resource).href,
    };
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const requestId = randomToken(24);
    await this.clientsStore.putPending(requestId, {
      clientId: client.client_id,
      params: this.storedParams(params),
      expiresAt: Date.now() + 10 * 60_000,
    });
    res.redirect(302, new URL(`/oauth/approve?request_id=${encodeURIComponent(requestId)}`, this.issuer).href);
  }

  async getApprovalPage(requestId: string): Promise<string> {
    const pending = await this.clientsStore.getPending(requestId);
    if (!pending || pending.expiresAt <= Date.now()) throw new InvalidGrantError("Authorization request expired");
    const client = await this.clientsStore.getClient(pending.clientId);
    const clientName = client?.client_name ?? pending.clientId;
    const scopes = pending.params.scopes.map((scope) => `<li><code>${htmlEscape(scope)}</code></li>`).join("");
    return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>授权 ChatGPT GitHub MCP App</title>
<style>body{font-family:system-ui,sans-serif;max-width:640px;margin:48px auto;padding:0 18px;line-height:1.55}form{display:grid;gap:14px;padding:22px;border:1px solid #ddd;border-radius:14px}input,button{font:inherit;padding:10px}button{cursor:pointer}.actions{display:flex;gap:10px}.deny{background:#fff;border:1px solid #aaa}</style></head>
<body><h1>授权 GitHub 写入桥接服务</h1><p>客户端 <strong>${htmlEscape(clientName)}</strong> 请求连接你的自建 MCP 服务。</p>
<p>目标资源：<code>${htmlEscape(pending.params.resource ?? this.resource.href)}</code></p><p>请求权限：</p><ul>${scopes}</ul>
<form method="post" action="/oauth/approve"><input type="hidden" name="request_id" value="${htmlEscape(requestId)}">
<label>管理员密码（批准时必填）<input type="password" name="password" autocomplete="current-password"></label>
<div class="actions"><button type="submit" name="action" value="approve">批准连接</button><button class="deny" type="submit" name="action" value="deny">拒绝</button></div></form></body></html>`;
  }

  private verifyAdminPassword(password: string): boolean {
    const [algorithm, saltEncoded, hashEncoded] = this.config.oauthAdminPasswordHash.split(":");
    if (algorithm !== "scrypt" || !saltEncoded || !hashEncoded) return false;
    const expected = Buffer.from(hashEncoded, "base64url");
    const actual = scryptSync(password, Buffer.from(saltEncoded, "base64url"), expected.length);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  async completeAuthorization(requestId: string, password: string, action: "approve" | "deny"): Promise<string> {
    const pending = await this.clientsStore.takePending(requestId);
    if (!pending || pending.expiresAt <= Date.now()) throw new InvalidGrantError("Authorization request expired");
    const target = new URL(pending.params.redirectUri);
    if (action === "deny") {
      target.searchParams.set("error", "access_denied");
      target.searchParams.set("error_description", "The user denied the request");
    } else {
      if (!this.verifyAdminPassword(password)) throw new AccessDeniedError("Incorrect administrator password");
      const code = randomToken(32);
      await this.clientsStore.putCode(code, {
        clientId: pending.clientId,
        params: pending.params,
        expiresAt: Date.now() + 5 * 60_000,
      });
      target.searchParams.set("code", code);
    }
    if (pending.params.state) target.searchParams.set("state", pending.params.state);
    return target.href;
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    const record = await this.clientsStore.getCode(authorizationCode);
    if (!record || record.expiresAt <= Date.now() || record.clientId !== client.client_id) {
      throw new InvalidGrantError("Invalid or expired authorization code");
    }
    return record.params.codeChallenge;
  }

  private async issueTokens(clientId: string, scopes: string[], resource: string): Promise<OAuthTokens> {
    const now = Math.floor(Date.now() / 1000);
    const accessToken = await new SignJWT({ client_id: clientId, scope: scopes.join(" ") })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuer(this.issuer.href)
      .setAudience(resource)
      .setSubject("self-hosted-admin")
      .setIssuedAt(now)
      .setExpirationTime(now + this.config.accessTokenTtlSeconds)
      .sign(this.signingKey);
    const refreshToken = randomToken(48);
    await this.clientsStore.putRefreshToken(refreshToken, {
      clientId,
      scopes,
      resource,
      expiresAt: Date.now() + this.config.refreshTokenTtlSeconds * 1000,
    });
    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: this.config.accessTokenTtlSeconds,
      refresh_token: refreshToken,
      scope: scopes.join(" "),
    };
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const record = await this.clientsStore.takeCode(authorizationCode);
    if (!record || record.expiresAt <= Date.now() || record.clientId !== client.client_id) {
      throw new InvalidGrantError("Invalid or expired authorization code");
    }
    if (redirectUri && redirectUri !== record.params.redirectUri) throw new InvalidGrantError("redirect_uri mismatch");
    const expectedResource = this.validateResource(resource).href;
    if (record.params.resource !== expectedResource) throw new InvalidTargetError("resource mismatch");
    return this.issueTokens(client.client_id, record.params.scopes, expectedResource);
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, scopes?: string[], resource?: URL): Promise<OAuthTokens> {
    const record = await this.clientsStore.takeRefreshToken(refreshToken);
    if (!record || record.expiresAt <= Date.now() || record.clientId !== client.client_id) {
      throw new InvalidGrantError("Invalid or expired refresh token");
    }
    const expectedResource = this.validateResource(resource).href;
    if (record.resource !== expectedResource) throw new InvalidTargetError("resource mismatch");
    const nextScopes = scopes?.length ? this.validateScopes(scopes) : record.scopes;
    if (nextScopes.some((scope) => !record.scopes.includes(scope))) throw new InvalidScopeError("Refresh request expands granted scopes");
    return this.issueTokens(client.client_id, nextScopes, expectedResource);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    try {
      const result = await jwtVerify(token, this.signingKey, {
        algorithms: ["HS256"],
        issuer: this.issuer.href,
        audience: this.resource.href,
      });
      const clientId = typeof result.payload.client_id === "string" ? result.payload.client_id : "";
      const scopes = typeof result.payload.scope === "string" ? result.payload.scope.split(" ").filter(Boolean) : [];
      if (!clientId || !result.payload.exp) throw new Error("Missing token claims");
      return {
        token,
        clientId,
        scopes,
        expiresAt: result.payload.exp,
        resource: this.resource,
        extra: { subject: result.payload.sub ?? "self-hosted-admin" },
      };
    } catch {
      throw new InvalidTokenError("Invalid or expired access token");
    }
  }

  async revokeToken(_client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    await this.clientsStore.revokeRefreshToken(request.token);
  }
}
