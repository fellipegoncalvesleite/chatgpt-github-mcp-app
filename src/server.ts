import { createServer, type Server as HttpServer } from "node:http";
import { pathToFileURL } from "node:url";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthRouter,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { AppConfig } from "./config.js";
import { loadConfig } from "./config.js";
import { AuditLogger } from "./audit.js";
import { AppError, toErrorMessage } from "./errors.js";
import { OAuthError, ServerError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { GitHubService } from "./github/service.js";
import { createGitHubMcpServer, type GitHubToolService } from "./mcp.js";
import { OAUTH_SCOPES, SingleUserOAuthProvider } from "./oauth/provider.js";
import { SecurityPolicy } from "./security/policy.js";

export type AppDependencies = {
  config: AppConfig;
  github: GitHubToolService;
  audit: AuditLogger;
  oauth: SingleUserOAuthProvider;
};

function htmlPage(title: string, body: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font-family:system-ui,sans-serif;max-width:820px;margin:48px auto;padding:0 20px;line-height:1.65}code,pre{background:#f5f5f5;border-radius:6px}code{padding:2px 5px}pre{padding:14px;overflow:auto}a{color:#0969da}</style></head><body>${body}</body></html>`;
}

export function createApp(dependencies: AppDependencies): Express {
  const { config, github, audit, oauth } = dependencies;
  const allowedHosts = new Set([config.publicBaseUrl.hostname.toLowerCase(), "localhost", "127.0.0.1", "[::1]"]);
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use((req, res, next) => {
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
    res.json({ status: "ok", service: "chatgpt-github-write-bridge", version: "0.1.0" });
  });

  app.get("/", (_req, res) => {
    res.type("html").send(htmlPage("ChatGPT GitHub Write Bridge", [
      "<h1>ChatGPT GitHub Write Bridge</h1>",
      "<p>这是一个供 ChatGPT 连接的自建 MCP GitHub 写入桥接服务。</p>",
      `<p>MCP 地址：<code>${mcpUrl.href}</code></p>`,
      '<p><a href="/docs">部署与接入说明</a> · <a href="/healthz">健康检查</a></p>',
    ].join("")));
  });

  app.get("/docs", (_req, res) => {
    res.type("html").send(htmlPage("接入说明", [
      "<h1>接入 ChatGPT</h1>",
      `<p>将以下公开 HTTPS 地址添加为 ChatGPT 自定义 MCP App：<code>${mcpUrl.href}</code></p>`,
      "<p>首次连接会跳转到本服务的授权页。输入部署时配置的管理员密码批准连接。</p>",
      "<p>默认仅注册读取、创建分支/提交/PR、PR 评论工具；合并和删除分支默认不注册。</p>",
      "<p>完整配置步骤请查看项目压缩包中的 <code>README.md</code>。</p>",
    ].join("")));
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
    resourceName: "ChatGPT GitHub Write Bridge",
  }));

  const authMiddleware = requireBearerAuth({
    verifier: oauth,
    requiredScopes: [],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl),
  });

  app.post("/mcp", authMiddleware, async (req, res) => {
    const mcpServer = createGitHubMcpServer({ config, github, audit });
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
  });

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
    const code = error instanceof AppError ? error.code : (errorWithStatus?.type === "entity.too.large" ? "request_too_large" : "internal_error");
    res.status(status).json({ error: code, message: toErrorMessage(error) });
  });

  return app;
}

export function createDefaultDependencies(config = loadConfig()): AppDependencies {
  const policy = new SecurityPolicy(config);
  return {
    config,
    audit: new AuditLogger(config.auditLogPath),
    oauth: new SingleUserOAuthProvider(config),
    github: new GitHubService(config, policy),
  };
}

export function startServer(dependencies = createDefaultDependencies()): HttpServer {
  const app = createApp(dependencies);
  const server = createServer(app);
  server.listen(dependencies.config.port, "0.0.0.0", () => {
    console.log(`ChatGPT GitHub Write Bridge listening on ${dependencies.config.publicBaseUrl.href}`);
    console.log(`MCP endpoint: ${new URL("/mcp", dependencies.config.publicBaseUrl).href}`);
  });
  return server;
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  const server = startServer();
  const shutdown = (signal: string) => {
    console.log(`Received ${signal}; shutting down.`);
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
