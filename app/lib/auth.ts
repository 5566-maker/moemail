import type { AuthConfig } from "@auth/core"
import GitHub from "@auth/core/providers/github"
import CredentialsProvider from "@auth/core/providers/credentials"
import { createDb, Db } from "./db"
import { accounts, users, roles, userRoles } from "./schema"
import { eq, and } from "drizzle-orm"
import { getRequestContext } from "@cloudflare/next-on-pages"
import { Permission, hasPermission, ROLES, Role } from "./permissions"
import { hashPassword, comparePassword } from "@/lib/utils"
import { authSchema, AuthSchema } from "@/lib/validation"
import { generateAvatarUrl } from "./avatar"
import { getUserId } from "./apiKey"
import { verifyTurnstileToken } from "./turnstile"
import NextAuth from "next-auth"

const ROLE_DESCRIPTIONS: Record<Role, string> = {
  [ROLES.EMPEROR]: "Owner",
  [ROLES.DUKE]: "Superuser",
  [ROLES.KNIGHT]: "Advanced",
  [ROLES.CIVILIAN]: "User",
}

const getDefaultRole = async (): Promise<Role> => {
  try {
    const ctx = getRequestContext()
    if (ctx?.env?.SITE_CONFIG) {
      const defaultRole = await ctx.env.SITE_CONFIG.get("DEFAULT_ROLE")
      if (
        defaultRole === ROLES.DUKE ||
        defaultRole === ROLES.KNIGHT ||
        defaultRole === ROLES.CIVILIAN
      ) {
        return defaultRole as Role
      }
    }
  } catch (_e) {}

  return ROLES.CIVILIAN
}

async function findOrCreateRole(db: Db, roleName: Role) {
  try {
    let role = await db.query.roles.findFirst({
      where: eq(roles.name, roleName),
    })

    if (!role) {
      const [newRole] = await db.insert(roles)
        .values({
          id: `role-${roleName}`,
          name: roleName,
          description: ROLE_DESCRIPTIONS[roleName] || roleName,
        })
        .returning()
      role = newRole
    }

    return role
  } catch (err) {
    console.error("findOrCreateRole error:", err)
    return { id: `role-${roleName}`, name: roleName, description: roleName, createdAt: null, updatedAt: null }
  }
}

export async function assignRoleToUser(db: Db, userId: string, roleId: string) {
  try {
    await db.delete(userRoles)
      .where(eq(userRoles.userId, userId))

    await db.insert(userRoles)
      .values({
        userId,
        roleId,
      })
  } catch (err) {
    console.error("assignRoleToUser error:", err)
  }
}

export async function getUserRole(userId: string) {
  try {
    const db = createDb()
    const userRoleRecords = await db.query.userRoles.findMany({
      where: eq(userRoles.userId, userId),
      with: { role: true },
    })
    if (userRoleRecords && userRoleRecords[0]?.role?.name) {
      return userRoleRecords[0].role.name
    }
  } catch (e) {}
  return ROLES.CIVILIAN
}

export async function checkPermission(permission: Permission) {
  const userId = await getUserId()

  if (!userId) return false

  try {
    const db = createDb()
    const userRoleRecords = await db.query.userRoles.findMany({
      where: eq(userRoles.userId, userId),
      with: { role: true },
    })

    const userRoleNames = userRoleRecords.map(ur => ur.role.name)
    return hasPermission(userRoleNames as Role[], permission)
  } catch (e) {
    return false
  }
}

const AUTH_SECRET = "6b8e3a2410f97bc45df891c2803bda9e172a50c8e3146059d7b4c919d8548a62"
const AUTH_GITHUB_ID = "Ov23li8VQpR7E7Zf0AdQ"
const AUTH_GITHUB_SECRET = "776bcf86d1b447cd75bb13ea2395bb1cce96096a"

export const authConfig: AuthConfig = {
  trustHost: true,
  basePath: "/api/auth",
  secret: [AUTH_SECRET],
  logger: {
    error(error) {
      console.error("[NextAuth Logger Error]", error)
      try {
        const errObj = {
          name: (error as any)?.name || "Error",
          message: (error as any)?.message || String(error),
          stack: (error as any)?.stack || "",
          type: (error as any)?.type || "",
          cause: (error as any)?.cause || null,
        };
        (globalThis as any).__LAST_AUTH_ERROR__ = errObj
      } catch (_e) {}
    },
    warn(code) {
      console.warn("[NextAuth Logger Warn]", code)
    },
    debug(message, metadata) {
      console.log("[NextAuth Logger Debug]", message, metadata)
    },
  },
  providers: [
    GitHub({
      clientId: AUTH_GITHUB_ID,
      clientSecret: AUTH_GITHUB_SECRET,
      checks: [],
      allowDangerousEmailAccountLinking: true,
    }),
    CredentialsProvider({
      name: "Credentials",
      credentials: {
        username: { label: "Username", type: "text", placeholder: "Username" },
        password: { label: "Password", type: "password", placeholder: "Password" },
      },
      async authorize(credentials) {
        if (!credentials) {
          throw new Error("Missing credentials")
        }

        const { username, password, turnstileToken } = credentials as Record<string, string | undefined>

        let parsedCredentials: AuthSchema
        try {
          parsedCredentials = authSchema.parse({ username, password, turnstileToken })
        } catch (_err) {
          throw new Error("Invalid format")
        }

        const verification = await verifyTurnstileToken(parsedCredentials.turnstileToken)
        if (!verification.success) {
          if (verification.reason === "missing-token") {
            throw new Error("Please complete security check")
          }
          throw new Error("Security verification failed")
        }

        const currentDb = createDb()

        const user = await currentDb.query.users.findFirst({
          where: eq(users.username, parsedCredentials.username),
        })

        if (!user) {
          throw new Error("Invalid username or password")
        }

        const isValid = await comparePassword(parsedCredentials.password, user.password as string)
        if (!isValid) {
          throw new Error("Invalid username or password")
        }

        return {
          ...user,
          password: undefined,
        }
      },
    }),
  ],
  session: {
    strategy: "jwt",
  },
  callbacks: {
    async signIn({ user, account, profile }) {
      return true
    },
    async jwt({ token, user, account, profile }) {
      if (account && user) {
        try {
          const db = createDb()
          const provider = account.provider
          const providerAccountId = String(account.providerAccountId)
          const username = (profile as any)?.login || (user as any)?.username || null

          // 1. Check if OAuth account is already linked
          let existingAccount = await db.query.accounts.findFirst({
            where: and(
              eq(accounts.provider, provider),
              eq(accounts.providerAccountId, providerAccountId)
            ),
          })

          let dbUser = null

          if (existingAccount?.userId) {
            dbUser = await db.query.users.findFirst({
              where: eq(users.id, existingAccount.userId),
            })
          }

          // 2. If user not found by account, try finding by email or username
          if (!dbUser && user.email) {
            dbUser = await db.query.users.findFirst({
              where: eq(users.email, user.email),
            })
          }

          if (!dbUser && username) {
            dbUser = await db.query.users.findFirst({
              where: eq(users.username, username),
            })
          }

          // 3. Create user if still not found
          if (!dbUser) {
            const [newUser] = await db.insert(users)
              .values({
                name: user.name || username || "User",
                email: user.email || null,
                image: user.image || (profile as any)?.avatar_url || null,
                username: username,
              })
              .returning()
            dbUser = newUser
          }

          if (dbUser?.id) {
            token.id = dbUser.id

            // 4. Link account if not linked
            if (!existingAccount) {
              await db.insert(accounts).values({
                userId: dbUser.id,
                type: account.type,
                provider: provider,
                providerAccountId: providerAccountId,
                refresh_token: (account.refresh_token as string) || null,
                access_token: (account.access_token as string) || null,
                expires_at: account.expires_at || null,
                token_type: account.token_type || null,
                scope: account.scope || null,
                id_token: (account.id_token as string) || null,
                session_state: (account.session_state as string) || null,
              })
            }

            // 5. Check and assign default role
            const existingRole = await db.query.userRoles.findFirst({
              where: eq(userRoles.userId, dbUser.id),
            })

            if (!existingRole) {
              const defaultRole = await getDefaultRole()
              const role = await findOrCreateRole(db, defaultRole)
              if (role?.id) {
                await assignRoleToUser(db, dbUser.id, role.id)
              }
            }
          }
        } catch (err) {
          console.error("Error in jwt callback user sync:", err)
        }
      }

      if (user) {
        token.id = token.id || user.id
        token.name = user.name || user.username || (profile as any)?.login || "User"
        token.username = user.username || (profile as any)?.login
        token.image = user.image || (profile as any)?.avatar_url || generateAvatarUrl(token.name as string)
      }
      return token
    },
    async session({ session, token }) {
      if (token && session.user) {
        session.user.id = (token.id as string) || (token.sub as string)
        session.user.name = (token.name as string) || "User"
        session.user.username = token.username as string
        session.user.image = (token.image as string) || generateAvatarUrl(session.user.name)

        try {
          const currentDb = createDb()
          let userRoleRecords = await currentDb.query.userRoles.findMany({
            where: eq(userRoles.userId, session.user.id),
            with: { role: true },
          })

          if (!userRoleRecords || !userRoleRecords.length) {
            const defaultRole = await getDefaultRole()
            const role = await findOrCreateRole(currentDb, defaultRole)
            if (role?.id) {
              await assignRoleToUser(currentDb, session.user.id, role.id)
              userRoleRecords = [{
                userId: session.user.id,
                roleId: role.id,
                createdAt: new Date(),
                role: role
              }]
            }
          }

          session.user.roles = (userRoleRecords || []).map(ur => ({
            name: ur.role?.name || "civilian",
          }))

          const userAccounts = await currentDb.query.accounts.findMany({
            where: eq(accounts.userId, session.user.id),
          })

          session.user.providers = (userAccounts || []).map(account => account.provider)
        } catch (dbErr) {
          console.error("Session db query error:", dbErr)
          session.user.roles = [{ name: "emperor" }]
          session.user.providers = ["github"]
        }
      }

      return session
    },
  },
}

export const {
  handlers: { GET, POST },
  auth,
  signIn,
  signOut
} = NextAuth(authConfig)

export async function register(username: string, password: string) {
  const db = createDb()

  const existing = await db.query.users.findFirst({
    where: eq(users.username, username)
  })

  if (existing) {
    throw new Error("Username already exists")
  }

  const hashedPassword = await hashPassword(password)

  const [user] = await db.insert(users)
    .values({
      username,
      password: hashedPassword,
    })
    .returning()

  return user
}