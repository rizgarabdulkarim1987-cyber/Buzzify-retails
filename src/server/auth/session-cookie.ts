import { createHmac } from "node:crypto";
import { auth } from "./auth";

/*
 * Opens a Better Auth session for a user who proved who they are elsewhere (the Studio handoff),
 * from a Route Handler. Better Auth 1.7 has no public "sign this user in" API without a password
 * or a provider, and its setSessionCookie (better-auth/cookies) needs a live endpoint context
 * (ctx.setSignedCookie, ctx.getSignedCookie), which a plain Route Handler does not have. So:
 *   - the session row comes from Better Auth itself: (await auth.$context).internalAdapter.createSession,
 *     which applies session.expiresIn and generates the token;
 *   - the cookie is the one setSessionCookie would write: Better Auth's own name and attributes
 *     (ctx.authCookies.sessionToken: prefix, __Secure- in production, HttpOnly, SameSite=Lax,
 *     Path=/), Max-Age = sessionConfig.expiresIn, and the value signed the way better-call's
 *     setSignedCookie signs it: encodeURIComponent(`${token}.${base64(HMAC-SHA256(secret, token))}`).
 * tests/core/handoff.test.ts proves auth.api.getSession accepts the cookie. The cookie cache is not
 * enabled in auth.ts, so no session_data cookie is needed.
 */

export type OpenedSession = { setCookie: string; expiresAt: Date };

export async function openSession(userId: string, meta: { ipAddress?: string; userAgent?: string } = {}): Promise<OpenedSession> {
  const ctx = await auth.$context;
  const session = await ctx.internalAdapter.createSession(userId, false, {
    ipAddress: meta.ipAddress ?? "",
    userAgent: (meta.userAgent ?? "").slice(0, 512),
  });

  const signature = createHmac("sha256", ctx.secret).update(session.token, "utf8").digest("base64");
  const value = encodeURIComponent(`${session.token}.${signature}`);
  const { name, attributes } = ctx.authCookies.sessionToken;

  const parts = [`${name}=${value}`, `Max-Age=${ctx.sessionConfig.expiresIn}`, `Path=${attributes.path ?? "/"}`];
  if (attributes.domain) parts.push(`Domain=${attributes.domain}`);
  if (attributes.httpOnly !== false) parts.push("HttpOnly");
  if (attributes.secure) parts.push("Secure");
  const sameSite = String(attributes.sameSite ?? "lax").toLowerCase();
  parts.push(`SameSite=${sameSite.charAt(0).toUpperCase()}${sameSite.slice(1)}`);
  if (attributes.partitioned) parts.push("Partitioned");
  return { setCookie: parts.join("; "), expiresAt: session.expiresAt };
}
