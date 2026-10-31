import { createHmac, timingSafeEqual } from "node:crypto";
import { coreConfig } from "./config";

/*
 * Handoff token: base64url(json) "." base64url(hmac-sha256(first part)). Lifetime at most 60 s
 * from iat; audience must be "retail". Replay protection (jti) lives with the consumer.
 */

export const HANDOFF_MAX_AGE_SECONDS = 60;

export type HandoffClaims = {
  aud: "retail";
  iat: number;
  exp: number;
  nonce: string;
  jti: string;
  coreUserId: string;
  email: string;
  emailVerified: boolean;
  name: string;
  coreBusinessId: string;
};

export type HandoffResult =
  | { ok: true; claims: HandoffClaims }
  | { ok: false; reason: "FORMAT" | "SIGNATURE" | "EXPIRED" | "AUDIENCE" };

const b64url = (b: Buffer) => b.toString("base64url");
const macOf = (payload: string, secret: string) => createHmac("sha256", secret).update(payload, "utf8").digest();

export function signHandoffForTests(claims: HandoffClaims, secret: string): string {
  const payload = b64url(Buffer.from(JSON.stringify(claims), "utf8"));
  return `${payload}.${b64url(macOf(payload, secret))}`;
}

function isClaims(c: unknown): c is HandoffClaims {
  if (!c || typeof c !== "object") return false;
  const o = c as Record<string, unknown>;
  return (
    typeof o.aud === "string" &&
    Number.isFinite(o.iat) &&
    Number.isFinite(o.exp) &&
    ["nonce", "jti", "coreUserId", "email", "name", "coreBusinessId"].every((k) => typeof o[k] === "string") &&
    typeof o.emailVerified === "boolean"
  );
}

export function verifyHandoff(token: string, now: Date = new Date()): HandoffResult {
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: "FORMAT" };
  const [payload, sig] = parts;
  if (!/^[A-Za-z0-9_-]+$/.test(payload) || !/^[A-Za-z0-9_-]+$/.test(sig)) return { ok: false, reason: "FORMAT" };

  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "FORMAT" };
  }
  if (!isClaims(claims)) return { ok: false, reason: "FORMAT" };

  const given = Buffer.from(sig, "base64url");
  let match = false;
  for (const secret of coreConfig().handoffSecrets) {
    const expected = macOf(payload, secret);
    if (given.length === expected.length && timingSafeEqual(given, expected)) match = true;
  }
  if (!match) return { ok: false, reason: "SIGNATURE" };

  if (claims.aud !== "retail") return { ok: false, reason: "AUDIENCE" };

  const nowS = now.getTime() / 1000;
  if (claims.exp - claims.iat > HANDOFF_MAX_AGE_SECONDS) return { ok: false, reason: "EXPIRED" };
  if (nowS > claims.exp || nowS - claims.iat > HANDOFF_MAX_AGE_SECONDS) return { ok: false, reason: "EXPIRED" };
  return { ok: true, claims };
}
