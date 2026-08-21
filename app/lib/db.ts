import { getRequestContext } from "@cloudflare/next-on-pages"
import { drizzle } from "drizzle-orm/d1"
import * as schema from "./schema"

export const createDb = () => {
  try {
    const ctx = getRequestContext()
    if (ctx?.env?.DB) {
      return drizzle(ctx.env.DB, { schema })
    }
  } catch (_e) {}
  return drizzle((process.env as any).DB, { schema })
}

export type Db = ReturnType<typeof createDb>
