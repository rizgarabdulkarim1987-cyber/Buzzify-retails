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

/** Rows older than this are of no use to any user of the table (the login throttle's window is the longest). */
const PRUNE_AFTER_MS = LOGIN_WINDOW_MS;
const PRUNE_ODDS = 0.05;

/** Deletes every attempt older than the longest window in use. */
export async function pruneAttempts(now: Date = new Date()): Promise<number> {
  const { count } = await db.rtLoginAttempt.deleteMany({ where: { at: { lt: new Date(now.getTime() - PRUNE_AFTER_MS) } } });
  return count;
}

export async function coreRateLimit(scope: CoreRateScope, key: string): Promise<{ ok: boolean }> {
  if (Math.random() < PRUNE_ODDS) await pruneAttempts();
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
