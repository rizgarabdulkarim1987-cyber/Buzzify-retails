import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { nextCookies } from "better-auth/next-js";
import { db } from "@/server/db";

export const auth = betterAuth({
  database: prismaAdapter(db, { provider: "postgresql" }),
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.APP_URL,
  emailAndPassword: { enabled: true },
  // Lets server actions (sign in, sign out) set the session cookie. Must stay the last plugin.
  plugins: [nextCookies()],
});

/** The signed-in user's id for these request headers, or null. */
export async function getSessionUserId(headers: Headers): Promise<string | null> {
  const session = await auth.api.getSession({ headers });
  return session?.user.id ?? null;
}

export type SessionUser = { id: string; name: string; email: string };

/** The signed-in user (id, display name, email) for these request headers, or null. */
export async function getSessionUser(headers: Headers): Promise<SessionUser | null> {
  const session = await auth.api.getSession({ headers });
  if (!session) return null;
  const { id, name, email } = session.user;
  return { id, name, email };
}
