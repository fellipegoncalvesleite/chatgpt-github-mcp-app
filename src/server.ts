import { createServer, type Server as HttpServer } from "node:http";
import { pathToFileURL } from "node:url";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthRouter,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { OAuthError, ServerError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { AppConfig } from "./config.js";
import { gmailConfigured, loadConfig } from "./config.js";
import { AuditLogger } from "./audit.js";
import { AppError, toErrorMessage } from "./errors.js";
import { GitHubService } from "./github/service.js";
import type { GmailToolService } from "./gmail/mcp-tools.js";
import { GmailService, GoogleTokenProvider } from "./gmail/service.js";
import { LocalAgentGateway } from "./local/gateway.js";
import { createGitHubMcpServer, type GitHubToolService } from "./mcp.js";
import { OAUTH_SCOPES, SingleUserOAuthProvider } from "./oauth/provider.js";
import { SecurityPolicy } from "./security/policy.js";

export type AppDependencies = {
  config: AppConfig;
  github: GitHubToolService;
  audit: AuditLogger;
  oauth: SingleUserOAuthProvider;
  localGateway: LocalAgentGateway;
  gmail?: GmailToolService;
};

function htmlPage(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font-family:system-ui,sans-serif;max-width:820px;margin:48px auto;padding:0 20px;line-height:1.65}code,pre{background:#f5f5f5;border-radius:6px}code{padding:2px 5px}pre{padding:14px;overflow:auto}a{color:#0969da}</style></head><body>${body}</body></html>`;
}

function localAgentBearerToken(req: Request): string {
  const header = req.headers.authorization ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1]?.trim() ?? "";
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(min, Math.min(max, Math.floor(value)))
    : fallback;
}

export function createApp(dependencies: AppDependencies): Express {
  const { config, github, audit, oauth, localGateway, gmail } = dependencies;
  const allowedHosts = new Set([config.publicBaseUrl.hostname.toLowerCase(), "localhost", "127.0.0.1", "[::1]"]);
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use((req, res, next) => {
    if (req.path === "/" || req.path === "/healthz") {
      next();
      return;
    }
    const hostHeader = req.headers.host ?? "";
    const hostname = hostHeader.startsWith("[")
      ? hostHeader.slice(0, hostHeader.indexOf("]") + 1).toLowerCase()
      : hostHeader.split(":", 1)[0]!.toLowerCase();
    if (!allowedHosts.has(hostname)) {
      res.status(403).json({ error: "host_not_allowed", message: "Host header is not allowed" });
      return;
    }
    next();
  });
  app.use(express.json({ limit: config.maxHttpBodyBytes }));
  app.use(express.urlencoded({ extended: false, limit: "64kb" }));

  const issuerUrl = new URL("/", config.publicBaseUrl);
  const mcpUrl = new URL("/mcp", config.publicBaseUrl);
  const docsUrl = new URL("/docs", config.publicBaseUrl);

  app.get("/healthz", (_req, res) => {
    res.json({
      status: "ok",
      service: "chatgpt-development-bridge",
      version: "0.2.0",
      localAgent: localGateway.status(),
    });
  });

  app.get("/", (_req, res) => {
    const local = localGateway.status();
    res.type("html").send(htmlPage("ChatGPT Development Bridge", [
      "<h1>ChatGPT Development Bridge</h1>",
      "<p>A self-hosted MCP service for GitHub repository changes and an optional Mac-side local development agent.</p>",
      `<p>MCP endpoint: <code>${mcpUrl.href}</code></p>`,
      `<p>Local Mac agent: <strong>${local.connected ? "connected" : local.configured ? "configured, offline" : "not configured"}</strong></p>`,
      '<p><a href="/docs">Setup documentation</a> · <a href="/healthz">Health check</a></p>',
    ].join("")));
  });

  app.get("/docs", (_req, res) => {
    res.type("html").send(htmlPage("ChatGPT Development Bridge setup", [
      "<h1>Connect ChatGPT</h1>",
      `<p>Add this public HTTPS endpoint as the custom MCP app: <code>${mcpUrl.href}</code></p>`,
      "<p>The first connection redirects to this service's approval page. Enter the administrator password configured for this deployment.</p>",
      "<p>GitHub tools work entirely through the public gateway. Local filesystem, shell, terminal, process, and debugging tools require the optional Mac local agent.</p>",
      "<p>The Mac agent connects outward to this service; the Mac does not expose a public shell port.</p>",
      "<p>See <code>README.md</code> in the repository for gateway and Mac-agent setup.</p>",
    ].join("")));
  });

  app.get("/.well-known/oauth-protected-resource", (_req, res) => {
    res.json({
      resource: mcpUrl.href,
      authorization_servers: [issuerUrl.href],
      scopes_supported: [...OAUTH_SCOPES],
      resource_name: "ChatGPT Development Bridge",
      resource_documentation: docsUrl.href,
    });
  });

  app.post("/local-agent/poll", async (req, res, next) => {
    try {
      localGateway.assertToken(localAgentBearerToken(req));
      const agentId = typeof req.body?.agentId === "string" ? req.body.agentId : "";
      const waitMs = boundedNumber(req.body?.waitMs, config.localAgentPollWaitMs, 0, config.localAgentPollWaitMs);
      const work = await localGateway.poll(agentId, waitMs);
      if (work === null) {
        res.status(204).end();
        return;
      }
      res.json(work);
    } catch (error) {
      next(error);
    }
  });

  app.post("/local-agent/respond", (req, res, next) => {
    try {
      localGateway.assertToken(localAgentBearerToken(req));
      const agentId = typeof req.body?.agentId === "string" ? req.body.agentId : "";
      localGateway.respond(agentId, req.body?.response);
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  app.get("/oauth/approve", async (req, res, next) => {
    try {
      const requestId = typeof req.query.request_id === "string" ? req.query.request_id : "";
      if (!requestId) throw new AppError("missing_request_id", "Missing request_id", 400);
      res.type("html").send(await oauth.getApprovalPage(requestId));
    } catch (error) {
      next(error);
    }
  });

  app.post("/oauth/approve", async (req, res, next) => {
    try {
      const requestId = typeof req.body.request_id === "string" ? req.body.request_id : "";
      const password = typeof req.body.password === "string" ? req.body.password : "";
      const action = req.body.action === "deny" ? "deny" : "approve";
      if (!requestId) throw new AppError("missing_request_id", "Missing request_id", 400);
      const redirect = await oauth.completeAuthorization(requestId, password, action);
      res.redirect(302, redirect);
    } catch (error) {
      next(error);
    }
  });

  app.use(mcpAuthRouter({
    provider: oauth,
    issuerUrl,
    baseUrl: issuerUrl,
    resourceServerUrl: mcpUrl,
    serviceDocumentationUrl: docsUrl,
    scopesSupported: [...OAUTH_SCOPES],
    resourceName: "ChatGPT Development Bridge",
  }));

  const authMiddleware = requireBearerAuth({
    verifier: oauth,
    requiredScopes: [],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl),
  });

  const handleMcpPost = async (req: Request, res: Response) => {
    const mcpServer = createGitHubMcpServer({ config, github, audit, localGateway, ...(gmail ? { gmail } : {}) });
    const transport = new StreamableHTTPServerTransport();
    res.once("close", () => {
      void transport.close();
      void mcpServer.close();
    });
    try {
      await mcpServer.connect(transport as never);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("MCP request failed", error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  };

  app.post("/mcp", authMiddleware, handleMcpPost);
  app.post("/", authMiddleware, handleMcpPost);

  app.get("/mcp", authMiddleware, (_req, res) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "This server uses stateless Streamable HTTP; send MCP messages with POST." },
      id: null,
    });
  });

  app.delete("/mcp", authMiddleware, (_req, res) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "This stateless MCP server has no session to delete." },
      id: null,
    });
  });

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof OAuthError) {
      res.status(error instanceof ServerError ? 500 : 400).json(error.toResponseObject());
      return;
    }
    const errorWithStatus = error as { status?: unknown; type?: unknown };
    const inferredStatus = typeof errorWithStatus?.status === "number" ? errorWithStatus.status : 500;
    const status = error instanceof AppError ? error.status : inferredStatus;
    const code = error instanceof AppError
      ? error.code
      : errorWithStatus?.type === "entity.too.large"
        ? "request_too_large"
        : "internal_error";
    res.status(status).json({ error: code, message: toErrorMessage(error) });
  });

  return app;
}

export function createDefaultDependencies(config = loadConfig()): AppDependencies {
  const policy = new SecurityPolicy(config);
  const gmail = gmailConfigured(config)
    ? new GmailService({
      accountEmail: config.gmailAccountEmail,
      tokenProvider: new GoogleTokenProvider({
        clientId: config.gmailClientId,
        clientSecret: config.gmailClientSecret,
        refreshToken: config.gmailRefreshToken,
      }),
    })
    : undefined;
  return {
    config,
    audit: new AuditLogger(config.auditLogPath),
    oauth: new SingleUserOAuthProvider(config),
    github: new GitHubService(config, policy),
    localGateway: new LocalAgentGateway(config),
    ...(gmail ? { gmail } : {}),
  };
}

export function startServer(dependencies = createDefaultDependencies()): HttpServer {
  const app = createApp(dependencies);
  const server = createServer(app);
  server.listen(dependencies.config.port, "0.0.0.0", () => {
    console.log(`ChatGPT Development Bridge listening on ${dependencies.config.publicBaseUrl.href}`);
    console.log(`MCP endpoint: ${new URL("/mcp", dependencies.config.publicBaseUrl).href}`);
  });
  return server;
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  const dependencies = createDefaultDependencies();
  const server = startServer(dependencies);
  const shutdown = (signal: string) => {
    console.log(`Received ${signal}; shutting down.`);
    dependencies.localGateway.close();
    server.close((error) => {
      if (error) {
        console.error(error);
        process.exitCode = 1;
      }
    });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}
