import { createHash } from "node:crypto";
import { WINDOW_MS as LOGIN_WINDOW_MS } from "@/server/auth/login-throttle";
import { db } from "@/server/db";

/*
 * Rate limit for core endpoints, over RtLoginAttempt (like the login throttle): at most
 * CORE_RATE_LIMIT requests per CORE_RATE_WINDOW_MS per key (the client address). Only a sha256 of
 * "core:<scope>:<key>" is stored. Only allowed requests are recorded; refused ones are not, so the window
 * slides and a refused client is freed once its oldest requests age out. Count-then-insert is not
 * atomic, so this is a soft limit: a concurrent burst can slightly exceed CORE_RATE_LIMIT.
 */

export const CORE_RATE_LIMIT = 120;
export const CORE_RATE_WINDOW_MS = 60_000;

/** Separate buckets: unauthenticated handoff traffic can never use up the signed Studio sync's budget. */
export type CoreRateScope = "handoff" | "sync";

/**
 * The /login form's own limits, the same as the account system's sign-in: every attempt counts (the right password too),
 * per client address and per email, over a sliding ten minutes. Applied before the account system is asked, so a spray
 * against /login is held here and never reaches it.
 */
export const SIGNIN_WINDOW_MS = 10 * 60_000;
export const SIGNIN_IP_LIMIT = 20;
export const SIGNIN_EMAIL_LIMIT = 5;

/** Rows older than this are of no use to any user of the table (the login throttle's window is the longest). */
const PRUNE_AFTER_MS = LOGIN_WINDOW_MS;
const PRUNE_ODDS = 0.05;

/** Deletes every attempt older than the longest window in use. */
export async function pruneAttempts(now: Date = new Date()): Promise<number> {
  const { count } = await db.rtLoginAttempt.deleteMany({ where: { at: { lt: new Date(now.getTime() - PRUNE_AFTER_MS) } } });
  return count;
}

/**
 * Counts one /login step against each key, or none when any is used up (a refused attempt is not recorded, so the window
 * slides and frees the client as its oldest attempts age out). Keys are stored as sha256 of "signin:<kind>:<value>".
 */
export async function signInAttempt(keys: { ip: string; email?: string }, now: Date = new Date()): Promise<{ ok: boolean }> {
  if (Math.random() < PRUNE_ODDS) void pruneAttempts().catch(() => undefined);
  const since = new Date(now.getTime() - SIGNIN_WINDOW_MS);
  const checks: Array<{ key: string; limit: number }> = [{ key: signInKey("ip", keys.ip), limit: SIGNIN_IP_LIMIT }];
  if (keys.email !== undefined) checks.push({ key: signInKey("email", keys.email.trim().toLowerCase()), limit: SIGNIN_EMAIL_LIMIT });
  const used = await Promise.all(checks.map((c) => db.rtLoginAttempt.count({ where: { key: c.key, at: { gt: since } } })));
  if (checks.some((c, i) => used[i]! >= c.limit)) return { ok: false };
  await db.rtLoginAttempt.createMany({ data: checks.map((c) => ({ key: c.key, at: now })) });
  return { ok: true };
}

export const signInKey = (kind: "ip" | "email", value: string): string =>
  createHash("sha256").update(`signin:${kind}:${value}`, "utf8").digest("hex");

export async function coreRateLimit(scope: CoreRateScope, key: string): Promise<{ ok: boolean }> {
  // Housekeeping must never fail or slow a request: run it detached and swallow its errors.
  if (Math.random() < PRUNE_ODDS) void pruneAttempts().catch(() => undefined);
  const hashed = createHash("sha256").update(`core:${scope}:${key}`, "utf8").digest("hex");
  const now = new Date();
  const since = new Date(now.getTime() - CORE_RATE_WINDOW_MS);

  const used = await db.rtLoginAttempt.count({ where: { key: hashed, at: { gt: since } } });
  if (used >= CORE_RATE_LIMIT) return { ok: false };

  await db.$transaction([
    db.rtLoginAttempt.create({ data: { key: hashed, at: now } }),
    // Keep the table small: rows outside the window no longer count.
    db.rtLoginAttempt.deleteMany({ where: { key: hashed, at: { lte: since } } }),
  ]);
  return { ok: true };
}
