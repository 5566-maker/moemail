import { NextRequest, NextResponse } from "next/server"

export const runtime = 'edge'

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const error = url.searchParams.get("error") || "Unknown"
  const code = url.searchParams.get("code") || ""
  const lastError = (globalThis as any).__LAST_AUTH_ERROR__ || null

  console.error(`[Auth Error Route] Error: ${error}, Code: ${code}, LastError: ${JSON.stringify(lastError)}`)

  const html = `
    <!DOCTYPE html>
    <html lang="zh-CN">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>认证错误诊断</title>
        <style>
          body { font-family: system-ui, sans-serif; background: #0f172a; color: #f8fafc; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px; }
          .card { background: #1e293b; border-radius: 12px; padding: 32px; max-width: 650px; width: 100%; box-shadow: 0 10px 25px rgba(0,0,0,0.5); }
          h1 { color: #ef4444; font-size: 20px; margin-top: 0; }
          p { color: #94a3b8; line-height: 1.6; }
          .error-box { background: #0f172a; border-left: 4px solid #ef4444; padding: 12px 16px; border-radius: 4px; font-family: monospace; color: #fca5a5; margin: 16px 0; word-break: break-all; white-space: pre-wrap; }
          a { display: inline-block; background: #3b82f6; color: #fff; text-decoration: none; padding: 10px 20px; border-radius: 6px; font-weight: 500; margin-top: 16px; }
        </style>
      </head>
      <body>
        <div class="card">
          <h1>登录认证发生异常</h1>
          <p>NextAuth 抛出了以下错误类型：</p>
          <div class="error-box">Error: ${error} ${code ? `(Code: ${code})` : ''}

${lastError ? `【详细错误诊断日志】:\n` + JSON.stringify(lastError, null, 2) : '（服务端未产生额外捕获的堆栈）'}</div>
          <p>请点击下方按钮返回重试：</p>
          <a href="/zh-CN/login">返回登录页面</a>
        </div>
      </body>
    </html>
  `

  return new NextResponse(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
    },
  })
}
