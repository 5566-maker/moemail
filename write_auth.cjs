const fs = require('fs');
const path = require('path');

const authCode = \import NextAuth from "next-auth"
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
  const defaultRole = await getRequestContext().env.SITE_CONFIG.get("DEFAULT_ROLE")

  if (
    defaultRole === ROLES.DUKE ||
    defaultRole === ROLES.KNIGHT ||
    defaultRole === ROLES.CIVILIAN
  ) {
    return defaultRole as Role
  }

  return ROLES.CIVILIAN
}

async function findOrCreateRole(db: Db, roleName: Role) {
  let role = await db.query.roles.findFirst({
    where: eq(roles.name, roleName),
  })

  if (!role) {
    const [newRole] = await db.insert(roles)
      .values({
        name: roleName,
        description: ROLE_DESCRIPTIONS[roleName],
      })
      .returning()
    role = newRole
  }

  return role
}

export async function assignRoleToUser(db: Db, userId: string, roleId: string) {
  await db.delete(userRoles)
    .where(eq(userRoles.userId, userId))

  await db.insert(userRoles)
    .values({
      userId,
      roleId,
    })
}

export async function getUserRole(userId: string) {
  const db = createDb()
  const userRoleRecords = await db.query.userRoles.findMany({
    where: eq(userRoles.userId, userId),
    with: { role: true },
  })
  return userRoleRecords[0].role.name
}

export async function checkPermission(permission: Permission) {
  const userId = await getUserId()

  if (!userId) return false

  const db = createDb()
  const userRoleRecords = await db.query.userRoles.findMany({
    where: eq(userRoles.userId, userId),
    with: { role: true },
  })

  const userRoleNames = userRoleRecords.map(ur => ur.role.name)
  return hasPermission(userRoleNames as Role[], permission)
}

export const {
  handlers: { GET, POST },
  auth,
  signIn,
  signOut
} = NextAuth(() => {
  let env: any = {}
  try {
    env = getRequestContext()?.env || {}
  } catch (_e) {}

  const authSecret = env.AUTH_SECRET || process.env.AUTH_SECRET
  const githubId = env.AUTH_GITHUB_ID || process.env.AUTH_GITHUB_ID
  const githubSecret = env.AUTH_GITHUB_SECRET || process.env.AUTH_GITHUB_SECRET
  const googleId = env.AUTH_GOOGLE_ID || process.env.AUTH_GOOGLE_ID
  const googleSecret = env.AUTH_GOOGLE_SECRET || process.env.AUTH_GOOGLE_SECRET

  return {
    trustHost: true,
    secret: authSecret,
    adapter: DrizzleAdapter(createDb(), {
      usersTable: users,
      accountsTable: accounts,
    }),
    providers: [
      GitHub({
        clientId: githubId,
        clientSecret: githubSecret,
        allowDangerousEmailAccountLinking: true,
      }),
      Google({
        clientId: googleId,
        clientSecret: googleSecret,
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

          const db = createDb()

          const user = await db.query.users.findFirst({
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
    events: {
      async signIn({ user }) {
        if (!user.id) return

        try {
          const db = createDb()
          const existingRole = await db.query.userRoles.findFirst({
            where: eq(userRoles.userId, user.id),
          })

          if (existingRole) return

          const defaultRole = await getDefaultRole()
          const role = await findOrCreateRole(db, defaultRole)
          await assignRoleToUser(db, user.id, role.id)
        } catch (error) {
          console.error('Error assigning role:', error)
        }
      },
    },
    callbacks: {
      async jwt({ token, user }) {
        if (user) {
          token.id = user.id
          token.name = user.name || user.username
          token.username = user.username
          token.image = user.image || generateAvatarUrl(token.name as string)
        }
        return token
      },
      async session({ session, token }) {
        if (token && session.user) {
          session.user.id = token.id as string
          session.user.name = token.name as string
          session.user.username = token.username as string
          session.user.image = token.image as string

          const db = createDb()
          let userRoleRecords = await db.query.userRoles.findMany({
            where: eq(userRoles.userId, session.user.id),
            with: { role: true },
          })

          if (!userRoleRecords.length) {
            const defaultRole = await getDefaultRole()
            const role = await findOrCreateRole(db, defaultRole)
            await assignRoleToUser(db, session.user.id, role.id)
            userRoleRecords = [{
              userId: session.user.id,
              roleId: role.id,
              createdAt: new Date(),
              role: role
            }]
          }

          session.user.roles = userRoleRecords.map(ur => ({
            name: ur.role.name,
          }))

          const userAccounts = await db.query.accounts.findMany({
            where: eq(accounts.userId, session.user.id),
          })

          session.user.providers = userAccounts.map(account => account.provider)
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
\;

fs.writeFileSync(path.resolve('app/lib/auth.ts'), authCode, 'utf8');
console.log('auth.ts written accurately via node.');