import { Auth } from "@auth/core"
import { authConfig } from "@/lib/auth"
import { NextRequest } from "next/server"

export const runtime = 'edge'

export async function GET(req: NextRequest) {
  return Auth(req, authConfig)
}

export async function POST(req: NextRequest) {
  return Auth(req, authConfig)
}
