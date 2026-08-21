# MoeMail 临时邮箱系统与 Resend 发信服务全流程从零部署指南

本文档记录了从零开始搭建 **MoeMail 临时邮箱系统** 以及接入 **Resend 邮件发信服务** 的完整操作流程与避坑指南。

---

## 目录
1. [前置准备](#一前置准备)
2. [GitHub OAuth 认证配置](#二github-oauth-认证配置)
3. [Cloudflare 基础设施与资源创建](#三cloudflare-基础设施与资源创建)
4. [NextAuth 与 Edge Runtime 核心适配（关键避坑）](#四nextauth-与-edge-runtime-核心适配关键避坑)
5. [项目构建与 Pages 部署](#五项目构建与-pages-部署)
6. [Resend 发信服务集成与 DNS 解析](#六resend-发信服务集成与-dns-解析)
7. [管理员提权与收发信验证](#七管理员提权与收发信验证)
8. [常见问题排查指南 (FAQ)](#八常见问题排查指南-faq)

---

## 一、前置准备

1. **域名**：已接入 Cloudflare DNS 解析的自定义域名（例如 `your-domain.com`）。
2. **账号准备**：
   - **Cloudflare**（用于部署 Pages、Workers、D1 数据库、KV 存储与 Email Routing）
   - **GitHub**（用于代码托管及用户 OAuth 登录）
   - **Resend**（用于免费邮件发信，每月 3,000 封，每日 100 封）
3. **本地工具**：
   - Node.js (>= 18.0.0)
   - Git
   - Cloudflare Wrangler CLI (`npm install -g wrangler`)

---

## 二、GitHub OAuth 认证配置

用于支持用户直接使用 GitHub 账号登录 MoeMail。

1. 打开 [GitHub Developer Settings -> OAuth Apps](https://github.com/settings/developers)。
2. 点击 **New OAuth App**，填写以下信息：
   - **Application name**：`MoeMail`
   - **Homepage URL**：`https://your-domain.com`
   - **Authorization callback URL**：`https://your-domain.com/api/auth/callback/github`
3. 创建完成后，记录生成的凭据：
   - **Client ID**：`keyxxxxxxx`
   - 点击 **Generate a new client secret** 生成 **Client Secret**：`keyxxxxxxx`

---

## 三、Cloudflare 基础设施与资源创建

登录 Cloudflare 获取 **Account ID** 与 **API Token**（具有 Pages、D1、KV、Worker 编辑权限）：
- `CLOUDFLARE_ACCOUNT_ID`: `keyxxxxxxx`
- `CLOUDFLARE_API_TOKEN`: `keyxxxxxxx`

### 1. 创建 D1 数据库并执行迁移
```bash
# 1. 创建 D1 数据库
npx wrangler d1 create moemail-db

# 记录返回的 database_id: keyxxxxxxx
```

在本地项目中运行 Drizzle 数据库迁移（共 18 项表结构迁移）：
```bash
npx wrangler d1 migrations apply moemail-db --remote
```

初始化预置角色（皇帝、公爵、骑士、平民）：
```sql
-- 通过 wrangler 执行 SQL 写入预置角色
npx wrangler d1 execute moemail-db --remote --command "INSERT OR IGNORE INTO role (id, name, description) VALUES ('role-emperor', 'emperor', '皇帝(管理员)'), ('role-duke', 'duke', '公爵(高级)'), ('role-knight', 'knight', '骑士(进阶)'), ('role-civilian', 'civilian', '平民(普通)');"
```

### 2. 创建 KV 命名空间
```bash
# 创建站点配置 KV 命名空间
npx wrangler kv namespace create SITE_CONFIG

# 记录返回的 KV namespace id: keyxxxxxxx
```

初始化站点全局域名与默认配置：
```bash
npx wrangler kv key put --namespace-id keyxxxxxxx EMAIL_DOMAINS your-domain.com --remote
npx wrangler kv key put --namespace-id keyxxxxxxx DEFAULT_ROLE civilian --remote
npx wrangler kv key put --namespace-id keyxxxxxxx MAX_EMAILS 30 --remote
```

### 3. 部署邮件接收 Worker 并绑定 Email Routing
配置 `wrangler.email.json` 关联 D1 数据库与接收脚本 `workers/email-receiver.ts`，然后执行部署：
```bash
npx wrangler deploy -c wrangler.email.json
```
在 Cloudflare 控制台进入 **Email Routing**（电子邮件路由）：
1. 确认已开启 Email Routing 并添加缺失的 DNS MX 记录。
2. 在 **Routing Rules（路由规则）** 中编辑 **Catch-all address**：
   - **Action**：`Send to Worker`
   - **Destination Worker**：`moemail-email-receiver-worker`

### 4. 部署定时清理 Worker
配置 `wrangler.cleanup.json` 设定 Cron 触发器 `0 * * * *`（每小时触发一次），然后执行部署：
```bash
npx wrangler deploy -c wrangler.cleanup.json
```

---

## 四、NextAuth 与 Edge Runtime 核心适配（关键避坑）

在 Cloudflare Pages Edge Runtime 环境中运行 NextAuth v5 时，需特别注意以下几点配置（位于 `app/lib/auth.ts`）：

```typescript
import NextAuth from "next-auth"
import GitHub from "next-auth/providers/github"
import CredentialsProvider from "next-auth/providers/credentials"

export const {
  handlers: { GET, POST },
  auth,
  signIn,
  signOut
} = NextAuth({
  debug: false,
  trustHost: true,
  secret: "keyxxxxxxx", // 32位以上随机密钥
  providers: [
    GitHub({
      clientId: "keyxxxxxxx",
      clientSecret: "keyxxxxxxx",
      // 避坑点 1：必须显式声明 RFC 9207 Issuer，否则 GitHub 返回 iss 参数会导致校验抛错
      issuer: "https://github.com/login/oauth",
      // 避坑点 2：使用 POST 协议传递 Client Secret，符合 GitHub 规范
      client: {
        token_endpoint_auth_method: "client_secret_post",
      },
      // 避坑点 3：移除跨站 Cookie 强校验，避免重定向跳转时 Cookie 丢失报 Configuration 错误
      checks: [],
      allowDangerousEmailAccountLinking: true,
      profile(profile) {
        return {
          id: String(profile?.id || profile?.login || crypto.randomUUID()),
          name: profile?.name || profile?.login || "User",
          email: profile?.email || null,
          image: profile?.avatar_url || null,
        }
      },
    }),
    CredentialsProvider({ /* 账号密码认证逻辑 */ }),
  ],
  // 避坑点 4：使用纯 JWT Session 策略，禁止顶层 evaluate D1 适配器
  session: { strategy: "jwt" },
  callbacks: {
    async jwt({ token, user, account, profile }) {
      // 在请求生命周期内动态获取 DB 并写入用户与角色
      return token
    },
    async session({ session, token }) {
      // 组装用户角色与权限信息
      return session
    },
  },
})
```

---

## 五、项目构建与 Pages 部署

### 1. 构建 Next.js 边缘包
```bash
# 1. 使用 Vercel CLI 构建
npx vercel build --prod --yes

# 2. 转换为 Cloudflare Pages 边缘 Worker 格式
npx @cloudflare/next-on-pages --skip-build

# 3. 部署到 Cloudflare Pages
npx wrangler pages deploy .vercel/output/static --project-name moemail --branch main
```

### 2. 绑定 Pages 资源与自定义域名
1. 在 Cloudflare Pages 项目设置中：
   - 绑定 D1 数据库：变量名 `DB` -> 绑定 `moemail-db`。
   - 绑定 KV 命名空间：变量名 `SITE_CONFIG` -> 绑定 `SITE_CONFIG`。
2. 绑定自定义域名 `your-domain.com`，并在 Cloudflare DNS 中确认添加 CNAME 记录：
   - **Type**：`CNAME`
   - **Name**：`@`
   - **Target**：`moemail-xxx.pages.dev`
   - **Proxy status**：`Proxied`（开启橘色小云朵）

---

## 六、Resend 发信服务集成与 DNS 解析

### 1. 在 Resend 中添加域名
1. 登录 [Resend Domains](https://resend.com/domains)，点击 **Add Domain**。
2. 域名填写：`your-domain.com`，区域选择离你最近的区域（如 `ap-northeast-1` 东京）。

### 2. 在 Cloudflare DNS 添加发信解析记录
在 Cloudflare 控制台 -> 域名 `your-domain.com` -> **DNS 记录** 中添加 Resend 提供的记录：

| 类型 | 名称 (Name) | 内容 (Content) | 优先级 | 代理状态 | 说明 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **TXT** | `resend._domainkey` | `p=MIGfMA0GCSqGSI...（Resend提供的公钥）` | - | 仅 DNS (灰色) | DKIM 防伪签名 |
| **MX** | `send` | `feedback-smtp.ap-northeast-1.amazonses.com` | `10` | 仅 DNS (灰色) | SPF 邮件反弹路由 |
| **TXT** | `send` | `v=spf1 include:amazonses.com ~all` | - | 仅 DNS (灰色) | SPF 发信授权 |
| **TXT** | `_dmarc` | `v=DMARC1; p=none;` | - | 仅 DNS (灰色) | DMARC 保护策略 |

> ⚠️ **重点提示**：以上记录的名称均为子域（如 `send` 或 `resend._domainkey`），**切勿修改或覆盖现有的根域名 Cloudflare Email Routing MX 记录**，以保证收信不受影响。

### 3. 生成 API Key 并配置到 MoeMail
1. 在 [Resend API Keys](https://resend.com/api-keys) 点击 **Create API Key**，权限选 `Sending access` 或 `Full access`，复制生成的密钥 `keyxxxxxxx`。
2. 进入 MoeMail 系统设置：
   - 访问 `https://your-domain.com/zh-CN/profile`；
   - 找到底部的 **Resend 发件服务配置**；
   - 开启 **启用** 开关，粘贴 API Key (`keyxxxxxxx`) 并点击 **保存**。

---

## 七、管理员提权与收发信验证

### 1. 管理员提权
用户通过 GitHub 首次登录后，默认角色为 `civilian`（平民）。需通过 D1 执行提权：
```bash
# 查询用户 ID
npx wrangler d1 execute moemail-db --remote --command "SELECT id, username, email FROM user;"

# 将用户提权为最高权限 emperor
npx wrangler d1 execute moemail-db --remote --command "UPDATE user_role SET role_id = 'role-emperor' WHERE user_id = 'keyxxxxxxx';"
```

### 2. 邮件收发验证
1. **测试收信**：
   - 在 `https://your-domain.com/zh-CN/moe` 创建临时邮箱（如 `test@your-domain.com`）。
   - 从你的个人邮箱（如 Gmail）向 `test@your-domain.com` 发送邮件，几秒内即可在网页收件箱中实时查看到新邮件。
2. **测试发信**：
   - 选中该临时邮箱，点击 **撰写 / 发送**；
   - 填写收件人（如你的 Gmail）与邮件内容并发送；
   - 查看 Gmail 收件箱，确认收到发件人为 `test@your-domain.com` 的邮件。

---

## 八、常见问题排查指南 (FAQ)

### Q1: 点击 GitHub 登录立即跳转 `Error: Configuration`？
* **检查项 1**：GitHub Provider 是否配置了 `issuer: "https://github.com/login/oauth"`。由于 GitHub 升级了 RFC 9207 规范，缺失该参数会导致底层 `oauth4webapi` 拒绝回调。
* **检查项 2**：`AUTH_SECRET` 是否设置且长度大于 32 字符。
* **检查项 3**：GitHub OAuth App 中的 `Authorization callback URL` 是否严格为 `https://your-domain.com/api/auth/callback/github`。

### Q2: 登录后点击“进入邮箱”提示“权限不足 (403)”？
* **原因**：当前账号角色为 `civilian`（平民），该角色默认无权管理/创建邮箱。
* **解决**：在 D1 数据库 `user_role` 表中将该用户的 `role_id` 更新为 `role-emperor`。

### Q3: Resend 发信提示失败？
* **检查项 1**：Resend Domains 状态是否为绿色的 `Verified`。
* **检查项 2**：Cloudflare DNS 中的 DKIM、SPF 记录是否关闭了橘色云朵（必须设为 **DNS Only / 仅 DNS**）。
* **检查项 3**：是否超过了 Resend 免费额度（单日限额 100 封，月度限额 3,000 封）。
