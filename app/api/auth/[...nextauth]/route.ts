import { GET as authGET, POST as authPOST } from "@/lib/auth"
import { NextRequest, NextResponse } from "next/server"

export const runtime = 'edge'

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  console.log(`[NextAuth Route GET] ${url.pathname}${url.search}`)

  try {
    const res = await authGET(req)
    const location = res.headers.get("Location")
    console.log(`[NextAuth Route GET Response] Status: ${res.status}, Location: ${location}`)
    
    // If NextAuth is redirecting to error, inspect why
    if (location && location.includes("/error")) {
      console.error(`[NextAuth Error Redirect Detected] URL: ${url.href}, Redirect: ${location}`)
    }
    return res
  } catch (err: any) {
    console.error(`[NextAuth Route GET Exception]`, err?.stack || err?.message || err)
    return new NextResponse(JSON.stringify({
      error: "Exception in NextAuth GET handler",
      message: err?.message,
      stack: err?.stack,
    }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    })
  }
}

export async function POST(req: NextRequest) {
  const url = new URL(req.url)
  console.log(`[NextAuth Route POST] ${url.pathname}${url.search}`)

  try {
    const res = await authPOST(req)
    const location = res.headers.get("Location")
    console.log(`[NextAuth Route POST Response] Status: ${res.status}, Location: ${location}`)
    return res
  } catch (err: any) {
    console.error(`[NextAuth Route POST Exception]`, err?.stack || err?.message || err)
    return new NextResponse(JSON.stringify({
      error: "Exception in NextAuth POST handler",
      message: err?.message,
      stack: err?.stack,
    }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    })
  }
}
