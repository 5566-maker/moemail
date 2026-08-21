---
name: SetMoeMail
description: >-
  Use this skill when deploying, configuring, troubleshooting, or maintaining MoeMail
  (a full-featured temporary disposable email service) on Cloudflare Pages, D1 Database,
  KV Storage, Email Routing, and Resend outbound email service.
---

# SetMoeMail - MoeMail 部署与运维实战技能指南

本技能为 MoeMail 临时邮箱系统的全生命周期运维指南，涵盖从零部署、认证协议适配、邮件路由收信、Resend 发信配置以及疑难故障排查。

---

## 核心架构概览

- **前端与后端**：Next.js App Router (部署在 Cloudflare Pages Edge Runtime)
- **数据库**：Cloudflare D1 (`moemail-db` SQLite)
- **键值存储**：Cloudflare KV (`SITE_CONFIG`)
- **收信引擎**：Cloudflare Email Routing + Worker (`workers/email-receiver.ts`)
- **发信引擎**：Resend REST API (`https://api.resend.com/emails`)
- **定时清理**：Cloudflare Cron Worker (`workers/cleanup.ts`, `0 * * * *`)
- **身份认证**：NextAuth v5 (GitHub OAuth + JWT Session)

---

## 阶段一：GitHub OAuth 鉴权配置

1. 在 GitHub Developer Settings 创建 OAuth App：
   - **Homepage URL**：`https://your-domain.com`
   - **Authorization callback URL**：`https://your-domain.com/api/auth/callback/github`
2. 记录凭据：
   - `AUTH_GITHUB_ID`: `keyxxxxxxx`
   - `AUTH_GITHUB_SECRET`: `keyxxxxxxx`
   - `AUTH_SECRET`: `keyxxxxxxx`（生成 32 位以上随机密钥）

### 🚨 NextAuth v5 Edge 核心避坑要点 (`app/lib/auth.ts`)
- **必须显式声明 Issuer**：`issuer: "https://github.com/login/oauth"`（兼容 GitHub 新版 RFC 9207 规范，防止回调抛 `Configuration` 错误）。
- **必须使用 POST 协议**：`client: { token_endpoint_auth_method: "client_secret_post" }`。
- **禁用跨站 Cookie 强校验**：`checks: []`（避免 OAuth 跳转回站时由于 SameSite 丢失 Cookie 导致验证失败）。
- **纯 JWT 策略**：`session: { strategy: "jwt" }`，禁止顶层 evaluate D1 适配器。

---

## 阶段二：Cloudflare 基础设施初始化

### 1. D1 数据库
```bash
npx wrangler d1 create moemail-db
npx wrangler d1 migrations apply moemail-db --remote
npx wrangler d1 execute moemail-db --remote --command "INSERT OR IGNORE INTO role (id, name, description) VALUES ('role-emperor', 'emperor', '皇帝(管理员)'), ('role-duke', 'duke', '公爵(高级)'), ('role-knight', 'knight', '骑士(进阶)'), ('role-civilian', 'civilian', '平民(普通)');"
```

### 2. KV 命名空间
```bash
npx wrangler kv namespace create SITE_CONFIG
npx wrangler kv key put --namespace-id <KV_ID> EMAIL_DOMAINS your-domain.com --remote
npx wrangler kv key put --namespace-id <KV_ID> DEFAULT_ROLE civilian --remote
npx wrangler kv key put --namespace-id <KV_ID> MAX_EMAILS 30 --remote
```

### 3. Workers 部署
- **收信 Worker**：`npx wrangler deploy -c wrangler.email.json`
- **清理 Worker**：`npx wrangler deploy -c wrangler.cleanup.json`

---

## 阶段三：Cloudflare Email Routing 收信配置（收信核心）

1. **启用收件路由**：Cloudflare 控制台 -> 域名 -> **Email Routing** -> 点击启用。
2. **补全根域名 MX 解析**：
   - 点击 **添加缺失记录 (Add missing records)**；
   - 自动生成 3 条根域名 `@` MX 记录（`route1.mx.cloudflare.net` 等）和 1 条 SPF TXT 记录。
3. **设置全捕获 (Catch-all)**：
   - 规则状态：**开启 (Active)**
   - 操作：`Send to Worker` -> `moemail-email-receiver-worker`。

---

## 阶段四：Resend 发信集成与 DNS 隔离（发信核心）

1. **添加域名**：登录 Resend Domains，添加 `your-domain.com`（区域如 `ap-northeast-1`）。
2. **在 Cloudflare DNS 添加子域发信解析**：
   - **DKIM (TXT)**：`resend._domainkey` -> `p=MIGfMA0...` (仅 DNS)
   - **SPF (MX)**：`send` -> `feedback-smtp.ap-northeast-1.amazonses.com` (优先级 10, 仅 DNS)
   - **SPF (TXT)**：`send` -> `v=spf1 include:amazonses.com ~all` (仅 DNS)
   - **DMARC (TXT)**：`_dmarc` -> `v=DMARC1; p=none;` (仅 DNS)
   > ⚠️ **严禁覆盖根域名 `@` 的 Cloudflare Email Routing MX 记录！**
3. **绑定 API Key**：
   - Resend 创建 API Key（`re_xxxxxxx`）；
   - 在 MoeMail 个人中心（`/zh-CN/profile`）开启发信服务并填入 API Key。

---

## 阶段五：系统提权与运维管理

### 1. 管理员提权
首个 GitHub 用户注册后默认为 `civilian`，需提权为 `emperor`：
```bash
npx wrangler d1 execute moemail-db --remote --command "UPDATE user_role SET role_id = 'role-emperor' WHERE user_id = '<USER_ID>';"
```

### 2. 权限体系
- 👑 **Emperor (皇帝/管理员)**：无限发件、管理站点配置、用户提权。
- 🏰 **Duke (公爵) / ⚔️ Knight (骑士)**：可配置每日发件配额。
- 👤 **Civilian (平民)**：默认只收不发（防滥用）。

---

## 故障排查手册 (Troubleshooting)

| 故障现象 | 根本原因 | 解决方案 |
| :--- | :--- | :--- |
| **登录报 `Error: Configuration`** | GitHub 新规范下未传 `issuer` 或跨站 Cookie 丢失 | 在 `auth.ts` 中配置 `issuer: "https://github.com/login/oauth"` 并设置 `checks: []` |
| **收不到外部邮件** | 根域名 MX 记录未添加或 Catch-all 规则未绑定 Worker | 在 Email Routing 中点击「添加缺失记录」，并将 Catch-all 动作设为发送到 `moemail-email-receiver-worker` |
| **收信有几分钟延迟** | 刚配置 DNS 时外部邮件服务器（如 Gmail）DNS 缓存未刷新 | 等待 3~5 分钟 DNS 缓存 TTL 刷新后即可稳定秒级收信 |
| **进入邮箱提示 403 权限不足** | 用户角色为 `civilian` | 在 D1 `user_role` 表中将该用户的 `role_id` 更改为 `role-emperor` |
| **发信失败 (Resend Error)** | Resend 域名未 Verified 或 DNS 记录开启了橘色云朵代理 | 确保 DKIM/SPF 记录为 **DNS Only (灰色云朵)**，并在 Resend 确认状态为 `Verified` |