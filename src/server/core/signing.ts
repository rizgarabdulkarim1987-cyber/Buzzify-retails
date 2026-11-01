import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { coreConfig } from "./config";

/*
 * Signed requests between Retails and Studio. The signed string is
 * METHOD \n PATH \n TIMESTAMP \n SHA256(body), HMAC-SHA256, hex, in the x-bz-signature header;
 * x-bz-timestamp is unix seconds. The signed PATH is the request pathname plus the raw query
 * string exactly as sent (e.g. /api/core/v1/state?coreBusinessId=x); the body is the raw request text. Accepted skew is +-120 s. Nothing here logs secrets or bodies.
 */

export const MAX_SKEW_SECONDS = 120;

const sha256Hex = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

function mac(method: string, path: string, timestamp: string, body: string, secret: string): string {
  const text = `${method.toUpperCase()}\n${path}\n${timestamp}\n${sha256Hex(body)}`;
  return createHmac("sha256", secret).update(text, "utf8").digest("hex");
}

export function signRequest(method: string, path: string, body: string, secret: string, now: Date = new Date()) {
  const timestamp = String(Math.floor(now.getTime() / 1000));
  return { "x-bz-timestamp": timestamp, "x-bz-signature": mac(method, path, timestamp, body, secret) };
}

/** Constant-time compare of two hex strings; false on any length or format mismatch. */
function hexEqual(a: string, b: string): boolean {
  if (!/^[0-9a-f]+$/.test(a) || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

export type VerifyResult = { ok: true } | { ok: false; reason: "MISSING" | "SKEW" | "BAD_SIGNATURE" };

export function verifyRequest(
  req: { method: string; path: string; body: string; headers: Headers },
  now: Date = new Date(),
): VerifyResult {
  const timestamp = req.headers.get("x-bz-timestamp");
  const signature = req.headers.get("x-bz-signature");
  if (!timestamp || !signature) return { ok: false, reason: "MISSING" };
  if (!/^\d{1,12}$/.test(timestamp)) return { ok: false, reason: "BAD_SIGNATURE" };
  if (Math.abs(now.getTime() / 1000 - Number(timestamp)) > MAX_SKEW_SECONDS) return { ok: false, reason: "SKEW" };

  // Try every accepted secret without short-circuiting, so timing does not reveal which matched.
  let match = false;
  for (const secret of coreConfig().syncSecrets) {
    if (hexEqual(signature, mac(req.method, req.path, timestamp, req.body, secret))) match = true;
  }
  return match ? { ok: true } : { ok: false, reason: "BAD_SIGNATURE" };
}
