# ChatGPT GitHub MCP App

这是一个**自建 GitHub 写入桥接服务**：你在 ChatGPT 网页端添加这个远程 MCP App 后，就可以直接和 ChatGPT 对话，让它读取 GitHub 仓库、修改代码、创建提交和 Pull Request。

> 默认安全策略：只允许白名单仓库；写入时创建 `chatgpt/*` 分支和 PR；默认禁止直推默认分支、禁止自动合并、禁止修改 `.github/workflows`、禁止读写 `.env`/私钥类文件。

## 它能做什么

ChatGPT 连接后会看到这些工具：

| 工具 | 作用 | 默认权限 |
| --- | --- | --- |
| `github_list_repositories` | 列出允许访问的仓库 | 读 |
| `github_get_repository` | 查看仓库信息 | 读 |
| `github_list_tree` | 查看仓库文件树 | 读 |
| `github_read_file` | 读取文本文件 | 读 |
| `github_list_pull_requests` | 查看 PR 列表 | 读 |
| `github_get_pull_request` | 查看 PR 和变更文件 | 读 |
| `github_create_change` | 多文件原子提交并创建 PR | 写 |
| `github_comment_pull_request` | 给 PR 评论 | 写 |
| `github_merge_pull_request` | 合并 PR，仅 `ALLOW_MERGE=true` 注册 | 高危 |
| `github_delete_branch` | 删除 `chatgpt/*` 分支，仅 `ALLOW_DELETE_BRANCH=true` 注册 | 高危 |

## 运行要求

- Node.js 22+
- 一个 GitHub App
- 一个公网 HTTPS 域名，ChatGPT 需要能访问你的 `/mcp` 地址

## 1. 创建 GitHub App

在 GitHub 进入 **Settings → Developer settings → GitHub Apps → New GitHub App**。

推荐权限：

- Repository permissions
  - Contents: **Read and write**
  - Pull requests: **Read and write**
  - Metadata: **Read-only**，默认自带

Webhook 可以先关闭或留空。本项目主动调用 GitHub API，不依赖 webhook。

创建后：

1. 记录 **App ID**。
2. 点击 **Generate a private key** 下载 `.pem`。
3. 安装 GitHub App 到你要让 ChatGPT 操作的仓库。

## 2. 配置项目

```bash
cp .env.example .env
npm install
npm run generate:secrets
```

`generate:secrets` 会输出：

- `OAUTH_SIGNING_SECRET`
- `OAUTH_ADMIN_PASSWORD_HASH`

把输出值填入 `.env`。

推荐把 GitHub App 私钥放到：

```bash
mkdir -p secrets
cp your-github-app-private-key.pem secrets/github-app-private-key.pem
chmod 600 secrets/github-app-private-key.pem
```

然后在 `.env` 中配置：

```env
GITHUB_APP_ID=你的AppID
GITHUB_PRIVATE_KEY_PATH=/run/secrets/github-app-private-key.pem
GITHUB_ALLOWED_REPOSITORIES=你的用户名/你的仓库
PUBLIC_BASE_URL=https://你的域名
```

## 3. 本地开发运行

```bash
npm run dev
```

健康检查：

```bash
curl http://localhost:3000/healthz
```

本地只能用于开发。生产环境必须用 HTTPS，否则 ChatGPT 无法稳定连接 OAuth/MCP。

## 4. Docker 部署

```bash
cp .env.example .env
# 编辑 .env
mkdir -p data secrets
cp your-github-app-private-key.pem secrets/github-app-private-key.pem
docker compose up -d --build
```

检查：

```bash
curl https://你的域名/healthz
```

首页会显示 MCP 地址：

```text
https://你的域名/mcp
```

## 5. Nginx 反代

示例文件在：

```text
deploy/nginx.conf.example
```

重点：必须保留原始 Host，并通过 HTTPS 转发：

```nginx
proxy_set_header Host $host;
proxy_set_header X-Forwarded-Proto https;
```

## 6. 接入 ChatGPT 网页端

在 ChatGPT 网页端添加自定义 MCP App，填入：

```text
https://你的域名/mcp
```

首次连接时会跳转到本服务的授权页面。输入你部署时生成的管理员密码即可批准连接。

连接成功后，你可以直接对 ChatGPT 说：

```text
读取 owner/repo 这个仓库，帮我分析项目结构。然后把 xxx 功能改好，创建一个 PR，不要直接合并。
```

## 7. 推荐使用方式

比较稳的提示词：

```text
请使用我的 GitHub MCP App 操作 owner/repo。
先列出项目结构并读取相关文件；
然后说明你准备修改哪些文件；
最后用一次 github_create_change 提交所有相关文件并创建 PR。
不要修改 .env、私钥、GitHub Actions 工作流，也不要合并 PR。
```

## 8. 安全开关说明

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `GITHUB_ALLOWED_REPOSITORIES` | 空 | 允许访问的仓库白名单，生产强烈建议设置 |
| `ALLOW_ALL_INSTALLED_REPOS` | `false` | 是否允许全部已安装仓库 |
| `BRANCH_PREFIX` | `chatgpt/` | ChatGPT 创建分支的前缀 |
| `ALLOW_DEFAULT_BRANCH_WRITE` | `false` | 是否允许直推默认分支，不推荐 |
| `ALLOW_MERGE` | `false` | 是否注册 PR 合并工具 |
| `ALLOW_DELETE_BRANCH` | `false` | 是否注册删除分支工具 |
| `ALLOW_WORKFLOW_EDITS` | `false` | 是否允许改 `.github/workflows` |
| `PROTECTED_PATH_PATTERNS` | `.env`、私钥等 | 禁止读写的路径匹配 |
| `MAX_FILES_PER_CHANGE` | `30` | 单次最多改多少文件 |
| `MAX_FILE_BYTES` | `300000` | 单文件写入大小限制 |
| `MAX_TOTAL_CHANGE_BYTES` | `2000000` | 单次总写入大小限制 |

## 9. 审计日志

默认写入：

```text
data/audit.jsonl
```

每条记录包含：工具名、仓库、分支、路径、结果、错误摘要等。不要把这个日志公开。

## 10. 开发与测试

```bash
npm run typecheck
npm run test
npm run build
npm run check
```

当前测试覆盖：

- 安全策略：仓库白名单、敏感路径、工作流保护、分支保护
- GitHub 核心：多文件提交失败回滚
- MCP：工具注册、读写权限、危险工具开关
- HTTP/OAuth：动态客户端注册、PKCE 授权、token 交换、refresh rotation

## 11. 打包

```bash
bash scripts/package-release.sh
```

输出：

```text
release/chatgpt-github-mcp-app.zip
```

## 12. 重要提醒

- 这个服务需要公网 HTTPS 才适合接入 ChatGPT。
- 不要把 GitHub App 私钥、`.env`、`data/oauth-store.json`、`data/audit.jsonl` 上传到公开仓库。
- 第一次使用建议只给测试仓库授权，确认流程没问题后再扩大仓库白名单。
- 默认不会自动合并 PR；你可以在 GitHub 网页端 review 后手动合并。
