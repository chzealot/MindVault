# MindVault

个人知识库，基于 [Mintlify](https://mintlify.com) 构建，通过 OIDC 认证保护访问。

## 内容板块

- **Engineering** — 技术笔记：架构设计、后端、前端、DevOps、AI
- **Reading** — 读书笔记与摘要
- **Thinking** — 技术思考与生活感悟

## 本地开发

```bash
# 启动 Mintlify 开发服务器（无需认证，实时预览）
npx mintlify dev
```

### 运行认证服务器

```bash
# 1. 配置环境变量
cp .env.example .env
# 编辑 .env 填入 OIDC 客户端凭据和允许的用户列表

# 2. 安装依赖并启动
cd server
bun install
bun run index.js
```

## 部署

项目提供多阶段 Dockerfile，一步完成构建和部署：

```bash
docker build -t mindvault .
docker run -p 3000:3000 --env-file .env mindvault
```

## 添加内容

1. 在对应目录下创建 `.mdx` 文件（如 `engineering/backend/rust.mdx`）
2. 添加 YAML frontmatter：
   ```yaml
   ---
   title: 页面标题
   description: 页面描述
   ---
   ```
3. 在 `mint.json` 的 `navigation` 中注册新页面路径

## 环境变量

| 变量 | 说明 | 必填 |
|------|------|------|
| `OIDC_CLIENT_ID` | OIDC 客户端 ID | 是 |
| `OIDC_CLIENT_SECRET` | OIDC 客户端密钥 | 是 |
| `ALLOWED_USERS` | 允许访问的用户列表（逗号分隔的邮箱或手机号） | 是 |
| `SESSION_SECRET` | Session 加密密钥 | 是（生产环境） |
| `PORT` | 服务端口，默认 `3000` | 否 |
| `BASE_URL` | 服务基础 URL，默认 `http://localhost:3000` | 否 |
| `OIDC_DISCOVERY_URL` | OIDC 发现端点 URL | 否 |

## License

Private
