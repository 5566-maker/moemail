import NextAuth from "next-auth"
import GitHub from "next-auth/providers/github"
import Google from "next-auth/providers/google"
import { DrizzleAdapter } from "@auth/drizzle-adapter"
import { createDb, Db } from "./db"
import { accounts, users, roles, userRoles } from "./schema"
import { eq } from "drizzle-orm"
import { getRequestContext } from "@cloudflare/next-on-pages"
import { Permission, hasPermission, ROLES, Role } from "./permissions"
import CredentialsProvider from "next-auth/providers/credentials"
import { hashPassword, comparePassword } from "@/lib/utils"
import { authSchema, AuthSchema } from "@/lib/validation"
import { generateAvatarUrl } from "./avatar"
import { getUserId } from "./apiKey"
import { verifyTurnstileToken } from "./turnstile"

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

export const {
  handlers: { GET, POST },
  auth,
  signIn,
  signOut
} = NextAuth((_req) => {
  const db = createDb()

  const authProviders: any[] = [
    GitHub({
      clientId: process.env.AUTH_GITHUB_ID || "Ov23li8VQpR7E7Zf0AdQ",
      clientSecret: process.env.AUTH_GITHUB_SECRET || "7908ea306545e2a68ac4bfceb26a2afb46b9e6a0",
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
  ]

  if (process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET) {
    authProviders.push(
      Google({
        clientId: process.env.AUTH_GOOGLE_ID,
        clientSecret: process.env.AUTH_GOOGLE_SECRET,
        allowDangerousEmailAccountLinking: true,
      })
    )
  }

  return {
    trustHost: true,
    secret: process.env.AUTH_SECRET || "6b8e3a2410f97bc45df891c2803bda9e172a50c8e3146059d7b4c919d8548a62",
    adapter: DrizzleAdapter(db, {
      usersTable: users,
      accountsTable: accounts,
    }),
    providers: authProviders,
    events: {
      async signIn({ user }) {
        if (!user?.id) return

        try {
          const currentDb = createDb()
          const existingRole = await currentDb.query.userRoles.findFirst({
            where: eq(userRoles.userId, user.id),
          })

          if (existingRole) return

          const defaultRole = await getDefaultRole()
          const role = await findOrCreateRole(currentDb, defaultRole)
          if (role?.id) {
            await assignRoleToUser(currentDb, user.id, role.id)
          }
        } catch (error) {
          console.error('Error assigning role:', error)
        }
      },
    },
    callbacks: {
      async jwt({ token, user, profile }) {
        if (user) {
          token.id = user.id
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
    session: {
      strategy: "jwt",
    },
  }
})

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