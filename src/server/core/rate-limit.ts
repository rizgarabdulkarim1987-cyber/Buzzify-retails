import { createHash } from "node:crypto";
import { db } from "@/server/db";

/*
 * Rate limit for core endpoints, over RtLoginAttempt (like the login throttle): at most
 * CORE_RATE_LIMIT requests per CORE_RATE_WINDOW_MS per key (the client address). Only a sha256 of
 * "core:<key>" is stored. Only allowed requests are recorded; refused ones are not, so the window
 * slides and a refused client is freed once its oldest requests age out. Count-then-insert is not
 * atomic, so this is a soft limit: a concurrent burst can slightly exceed CORE_RATE_LIMIT.
 */

export const CORE_RATE_LIMIT = 120;
export const CORE_RATE_WINDOW_MS = 60_000;

export async function coreRateLimit(key: string): Promise<{ ok: boolean }> {
  const hashed = createHash("sha256").update(`core:${key}`, "utf8").digest("hex");
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
