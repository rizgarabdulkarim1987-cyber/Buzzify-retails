import { createHash } from "node:crypto";
import { isAPIError } from "better-auth/api";
import { db } from "@/server/db";
import { auth } from "./auth";

/*
 * Sign-in with throttling. Calling auth.api.signInEmail from a server action skips Better Auth's
 * own rate limiter (it lives in the HTTP router), so failures are counted here, in the database
 * (RtLoginAttempt), over a sliding window:
 *
 * - at most EMAIL_LIMIT failures per normalized email per WINDOW_MS (stops guessing one account);
 * - at most IP_LIMIT failures per client address per WINDOW_MS (stops spraying many accounts).
 *
 * At either limit the attempt is refused before the password is checked, with the same answer for
 * known and unknown accounts. A success clears that email's failures. Keys are stored as sha256
 * hashes only. The clock is the real one (tests use fake timers).
 */

export const WINDOW_MS = 15 * 60_000;
export const EMAIL_LIMIT = 5;
export const IP_LIMIT = 20;

export type SignInResult = { ok: true; userId: string } | { ok: false; reason: "INVALID_CREDENTIALS" | "THROTTLED" };

const hash = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const normalizeEmail = (email: string) => email.trim().toLowerCase();

/**
 * The client address: the first X-Forwarded-For hop, else X-Real-IP, else "unknown". These headers
 * are only as trustworthy as the proxy in front of the app; the email limit holds regardless.
 */
export function clientIp(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const ip = forwarded || headers.get("x-real-ip")?.trim() || "unknown";
  return ip.slice(0, 64);
}

async function failuresSince(key: string, since: Date): Promise<number> {
  return db.rtLoginAttempt.count({ where: { key, at: { gt: since } } });
}

export async function signInThrottled(input: { email: string; password: string }, headers: Headers): Promise<SignInResult> {
  const email = normalizeEmail(input.email);
  const emailKey = hash(`email:${email}`);
  const ipKey = hash(`ip:${clientIp(headers)}`);
  const now = new Date();
  const since = new Date(now.getTime() - WINDOW_MS);

  const [byEmail, byIp] = await Promise.all([failuresSince(emailKey, since), failuresSince(ipKey, since)]);
  if (byEmail >= EMAIL_LIMIT || byIp >= IP_LIMIT) return { ok: false, reason: "THROTTLED" };

  try {
    const result = await auth.api.signInEmail({ body: { email, password: input.password }, headers });
    await db.rtLoginAttempt.deleteMany({ where: { key: emailKey } });
    return { ok: true, userId: result.user.id };
  } catch (err) {
    if (!isAPIError(err)) throw err;
    await db.$transaction([
      db.rtLoginAttempt.createMany({ data: [{ key: emailKey, at: now }, { key: ipKey, at: now }] }),
      // Keep the table small: rows that left the window no longer count.
      db.rtLoginAttempt.deleteMany({ where: { key: { in: [emailKey, ipKey] }, at: { lte: since } } }),
    ]);
    return { ok: false, reason: "INVALID_CREDENTIALS" };
  }
}
