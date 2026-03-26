# CLAUDE.md

本文件为 Claude Code (claude.ai/code) 在此仓库中工作时提供指引。

## 项目概述

MindVault 是一个基于 [Mintlify](https://mintlify.com) 构建的个人知识库，通过 OIDC 认证服务器保护访问。内容分为三个板块：Engineering（工程）、Reading（阅读）、Thinking（思考）。

## 开发命令

```bash
# 本地运行 Mintlify 文档站点（无需认证）
npx mintlify dev

# 运行认证服务器（需要 .env 配置，参考 .env.example）
cd server && bun install && bun run index.js
```

```bash
# 构建静态站点（Docker 构建时使用）
npx mintlify build
# 输出目录：.mintlify/output/

# Docker 构建与运行
docker build -t mindvault .
docker run -p 3000:3000 --env-file .env mindvault
```

## 架构

- **内容层**：Mintlify 文档站点。页面为 `.mdx` 文件，按板块组织（`engineering/`、`reading/`、`thinking/`）。导航结构定义在 `mint.json` 中。
- **认证层**：`server/index.js` — Node.js/Express 服务器，通过 OIDC（OpenID Connect）+ PKCE 对静态站点进行访问控制。使用 `openid-client` v6 处理 OIDC 流程，通过用户白名单（`ALLOWED_USERS` 环境变量）限制访问。
- **部署**：多阶段 Dockerfile — 第一阶段构建 Mintlify 站点，第二阶段运行 Express 认证服务器并提供静态文件服务。

## 内容规范

- 所有内容页面使用 `.mdx` 格式，包含 YAML frontmatter（`title`、`description`）
- 新页面必须在 `mint.json` 的对应导航分组中注册
- MDX 文件中可使用 Mintlify 组件（`<Card>`、`<CardGroup>` 等）
