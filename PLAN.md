# ChatGPT GitHub Write Bridge：开发计划书

> 目标：开发一个可由 ChatGPT 网页端直接连接的远程 MCP App。用户在 ChatGPT 对话中提出开发需求，ChatGPT 可读取已授权 GitHub 仓库、修改多个文件、创建提交、创建 Pull Request，并在明确开启后执行合并。

## 1. 项目定位

本项目不是另做一个聊天网页，而是提供一个公开 HTTPS `/mcp` 端点，作为 ChatGPT Apps / 自定义 MCP App 接入 ChatGPT。服务端持有 GitHub App 凭据，代表已安装的 GitHub App 调用 GitHub API。

数据流：

```text
用户 ↔ ChatGPT 网页端
          │ MCP Streamable HTTP + OAuth 2.1
          ▼
自建 MCP App / GitHub 写入桥接服务
          │ GitHub App JWT → Installation Token
          ▼
GitHub 仓库 → 分支 → 多文件原子提交 → Pull Request
```

## 2. 目标与非目标

### 2.1 首版目标

- ChatGPT 可发现并调用仓库读取、目录树、文件读取、PR 查询等工具。
- ChatGPT 可一次性新增、修改、删除多个文本文件，并创建一个原子提交。
- 默认从默认分支创建 `chatgpt/*` 分支并创建 Pull Request。
- 默认禁止直接写入默认分支、禁止自动合并、禁止修改 `.github/workflows/`。
- GitHub App 凭据只保存在服务端，不进入 ChatGPT 上下文或工具结果。
- 支持仓库白名单、OAuth 2.1、PKCE、短期访问令牌、审计日志和请求大小限制。
- 提供 Docker 部署、反向代理示例、ChatGPT 接入指南、GitHub App 创建指南和测试。

### 2.2 首版非目标

- 不在服务器上 clone 仓库或执行仓库代码，避免远程代码执行风险。
- 不提供任意 shell、GitHub Actions secrets、仓库管理权限。
- 不保证替代完整 IDE/Codex 沙箱；首版专注于“读代码 + 写文件 + PR”。
- 不默认提供公众多租户服务；内置 OAuth 面向单用户/小团队自建部署。

## 3. 平台现实与限制

- ChatGPT 自定义 App 需要可公开访问的 HTTPS `/mcp` 端点。
- 写操作应声明为写工具，ChatGPT 会展示调用参数并要求用户确认。
- OpenAI 当前文档对不同套餐/工作区的自定义 MCP 写操作可用性仍可能变化；部署前需在当前账号的“设置 → Apps / Connectors → 高级设置”确认开发者模式与写工具是否开放。
- GitHub App 需要至少授予：`Contents: Read & write`、`Pull requests: Read & write`、`Metadata: Read-only`。只有确实需要改工作流时才增加 `Workflows: Read & write`。

## 4. 安全基线

1. **最小权限**：GitHub App 仅访问安装时选择的仓库，服务端再叠加显式仓库白名单。
2. **默认 PR 工作流**：写入新分支，禁止直接写默认分支。
3. **危险能力默认关闭**：自动合并、工作流编辑、删除分支均由环境变量单独开启。
4. **OAuth 2.1 + PKCE**：ChatGPT 连接时完成用户授权；访问令牌短期有效，刷新令牌轮换。
5. **输入校验**：校验仓库名、Git ref、分支名、路径、文件数量、单文件与总内容大小。
6. **并发保护**：以基准提交 SHA 创建提交，分支更新使用非强制更新，避免静默覆盖并发修改。
7. **敏感文件保护**：默认阻止 `.github/workflows/`、私钥、常见环境文件和超大/二进制内容。
8. **审计日志**：记录调用人、工具、仓库、分支、文件路径、结果和 GitHub URL，但不记录文件正文与令牌。
9. **无代码执行**：服务端只调用 GitHub REST API，不 checkout、不运行测试、不执行用户代码。

## 5. MCP 工具设计

### 5.1 读取工具

| 工具 | 用途 |
|---|---|
| `github_list_repositories` | 列出服务允许访问的仓库 |
| `github_get_repository` | 获取默认分支、描述、可见性等信息 |
| `github_list_tree` | 列出指定 ref 的目录树，可按路径前缀过滤 |
| `github_read_file` | 读取文本文件，返回内容、SHA、大小和 GitHub URL |
| `github_list_pull_requests` | 查询 PR |
| `github_get_pull_request` | 获取 PR 状态与变更文件摘要 |

### 5.2 写入工具

| 工具 | 用途 | 默认状态 |
|---|---|---|
| `github_create_change` | 多文件原子提交，可自动创建 PR | 开启，需确认 |
| `github_comment_pull_request` | 给 PR 添加说明/复核意见 | 开启，需确认 |
| `github_merge_pull_request` | 合并 PR | 默认关闭，需确认 |
| `github_delete_branch` | 删除非保护分支 | 默认关闭，危险操作 |

## 6. `github_create_change` 工作流

1. 校验仓库在安装范围和服务白名单内。
2. 读取仓库默认分支与基准 SHA。
3. 创建或复用符合前缀要求的工作分支。
4. 校验每个变更的路径、操作和大小。
5. 为新增/修改文件创建 Git blob；删除文件写入 `sha: null`。
6. 基于当前树创建新 tree。
7. 创建一个包含全部文件变更的 commit。
8. 非强制更新工作分支 ref；并发冲突时失败并要求重新读取。
9. 可选创建 Pull Request，并返回提交/分支/PR URL。
10. 写入审计日志。

## 7. 技术选型

- Node.js 22 + TypeScript
- `@modelcontextprotocol/sdk`：MCP Server / Streamable HTTP
- Express：HTTP、OAuth 元数据、健康检查
- `@octokit/rest` + `@octokit/auth-app`：GitHub App 鉴权与 REST API
- `jose`：OAuth Access Token JWT 签发与验证
- Zod：配置和工具输入校验
- Vitest：单元测试
- Docker / Docker Compose：部署

## 8. 开发阶段与验收标准

### 阶段 0：计划与骨架
- [x] 创建计划书
- [ ] 创建 TypeScript 项目骨架、配置和脚本

验收：`npm install`、`npm run typecheck` 可运行。

### 阶段 1：配置、安全策略、审计
- [ ] 环境变量校验
- [ ] 仓库白名单、路径保护、分支策略、大小限制
- [ ] JSONL 审计日志

验收：策略单元测试覆盖允许/拒绝路径及仓库。

### 阶段 2：GitHub App 接入
- [ ] GitHub App JWT 与 Installation Token
- [ ] 仓库读取、目录树、文件读取、PR 查询
- [ ] 多文件 Git Data API 原子提交
- [ ] PR 创建、评论、可选合并/删分支

验收：使用 mock 测试关键调用顺序；真实凭据下可创建测试 PR。

### 阶段 3：MCP 工具层
- [ ] Streamable HTTP `/mcp`
- [ ] 工具描述、Zod Schema、读写/危险注解
- [ ] 结构化结果与错误处理

验收：MCP Inspector 可列出和调用全部工具；写工具被标记为需确认。

### 阶段 4：OAuth 2.1 单用户授权
- [ ] Protected Resource Metadata
- [ ] Authorization Server Metadata
- [ ] DCR、Authorization Code + PKCE、Refresh Token Rotation
- [ ] Bearer Token 验证与 scope 校验

验收：MCP Inspector/ChatGPT 可完成授权；无令牌请求返回标准 `WWW-Authenticate`。

### 阶段 5：部署与接入文档
- [ ] Dockerfile、Compose、健康检查
- [ ] Nginx/Cloudflare Tunnel 示例
- [ ] GitHub App 创建、ChatGPT 接入、运维、安全文档
- [ ] 示例对话提示词

验收：按文档从零部署后，可在 ChatGPT 中读取仓库并创建 PR。

### 阶段 6：测试、打包与交付
- [ ] 类型检查、单元测试、构建
- [ ] 秘钥泄漏扫描和压缩包内容检查
- [ ] 生成最终 zip

验收：压缩包不含 `.env`、私钥、token、运行数据或 `node_modules`；解压后可按 README 部署。

## 9. 交付物

- 完整 TypeScript 源码
- `PLAN.md` 与中文 `README.md`
- `.env.example`
- GitHub App / ChatGPT / Docker / Nginx 配置文档
- 单元测试
- 最终压缩包 `chatgpt-github-mcp-app.zip`

## 10. 后续可选增强

- 使用 Auth0/Okta/Cognito 替换内置单用户 OAuth。
- 增加 GitHub Webhook、PR 检查状态、review、issue、分支保护感知。
- 增加基于 patch 的修改工具及大仓库代码索引。
- 增加审批策略：按仓库/目录/文件类型设置不同写入权限。
- 增加多用户数据库和角色权限。

## 11. 官方依据

- OpenAI Apps SDK / MCP Server：<https://developers.openai.com/apps-sdk/concepts/mcp-server>
- OpenAI Apps SDK / Build MCP server：<https://developers.openai.com/apps-sdk/build/mcp-server>
- OpenAI Apps SDK / Authentication：<https://developers.openai.com/apps-sdk/build/auth>
- OpenAI Apps SDK / Connect from ChatGPT：<https://developers.openai.com/apps-sdk/deploy/connect-chatgpt>
- GitHub App installation token：<https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app>
- GitHub REST Git Trees / Commits / Refs / Pull Requests：<https://docs.github.com/en/rest/git>
