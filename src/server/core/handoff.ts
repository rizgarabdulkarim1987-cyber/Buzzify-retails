import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { CoreConfigError, coreConfig } from "./config";

/*
 * Handoff token: base64url(json) "." base64url(hmac-sha256(first part)). Lifetime at most 60 s
 * from iat; audience must be "retail". Replay protection (jti) lives with the consumer.
 */

export const HANDOFF_MAX_AGE_SECONDS = 60;
const MAX_TOKEN_LENGTH = 4096;
const FUTURE_IAT_LEEWAY_SECONDS = 5;

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
  /** Absent/null/"" for staff who have no Studio business membership; then no business is resolved. */
  coreBusinessId?: string | null;
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
    ["nonce", "jti", "coreUserId", "email", "name"].every((k) => typeof o[k] === "string") &&
    (o.coreBusinessId === undefined || o.coreBusinessId === null || typeof o.coreBusinessId === "string") &&
    typeof o.emailVerified === "boolean"
  );
}

export function verifyHandoff(token: string, now: Date = new Date()): HandoffResult {
  if (token.length > MAX_TOKEN_LENGTH) return { ok: false, reason: "FORMAT" };
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: "FORMAT" };
  const [payload, sig] = parts;
  if (!/^[A-Za-z0-9_-]+$/.test(payload) || !/^[A-Za-z0-9_-]+$/.test(sig)) return { ok: false, reason: "FORMAT" };

  // Authenticate the raw payload part before decoding or parsing it.
  const given = Buffer.from(sig, "base64url");
  let match = false;
  for (const secret of coreConfig().handoffSecrets) {
    const expected = macOf(payload, secret);
    if (given.length === expected.length && timingSafeEqual(given, expected)) match = true;
  }
  if (!match) return { ok: false, reason: "SIGNATURE" };

  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "FORMAT" };
  }
  if (!isClaims(claims)) return { ok: false, reason: "FORMAT" };

  if (claims.aud !== "retail") return { ok: false, reason: "AUDIENCE" };

  const nowS = now.getTime() / 1000;
  if (claims.exp <= claims.iat || claims.exp - claims.iat > HANDOFF_MAX_AGE_SECONDS) return { ok: false, reason: "EXPIRED" };
  if (claims.iat > nowS + FUTURE_IAT_LEEWAY_SECONDS) return { ok: false, reason: "EXPIRED" };
  if (nowS > claims.exp || nowS - claims.iat > HANDOFF_MAX_AGE_SECONDS) return { ok: false, reason: "EXPIRED" };
  return { ok: true, claims };
}

/*
 * Browser side of the handoff (no database here). /start puts a random `state` and the internal
 * path to come back to in a short-lived HttpOnly cookie scoped to the handoff routes, then sends
 * the browser to Studio; Studio sends it back to /callback with the token and the same state.
 * SameSite=Lax is what lets the cookie ride along on that top-level GET back from Studio.
 */

export const HANDOFF_START_PATH = "/api/core/v1/handoff/start";
export const HANDOFF_CALLBACK_PATH = "/api/core/v1/handoff/callback";
export const HANDOFF_STATE_COOKIE = "rt_core_handoff";
export const HANDOFF_STATE_MAX_AGE_SECONDS = 600;
/** Where a signed-in user lands when no (valid) returnTo was given: the same page password sign-in uses. */
export const DEFAULT_RETURN_TO = "/retail/home";
/** Every failure lands here; the page shows one generic message, never the reason. */
export const HANDOFF_FAILURE_PATH = "/login?error=core";
const MAX_RETURN_TO_LENGTH = 512;
const COOKIE_PATH = "/api/core/v1/handoff";

/** `raw` when it is a path on this site, otherwise DEFAULT_RETURN_TO (no open redirect). */
export function safeReturnTo(raw: string | null | undefined): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_RETURN_TO_LENGTH) return DEFAULT_RETURN_TO;
  if (!raw.startsWith("/") || raw.startsWith("//")) return DEFAULT_RETURN_TO;
  // Backslashes (browsers read "/\" as "//"), control characters and encoded slashes are refused outright.
  if (/[\\\u0000-\u001f\u007f]/.test(raw) || /%(2f|5c)/i.test(raw)) return DEFAULT_RETURN_TO;
  try {
    const probe = "http://retails.invalid";
    if (new URL(raw, probe).origin !== probe) return DEFAULT_RETURN_TO;
  } catch {
    return DEFAULT_RETURN_TO;
  }
  return raw;
}

/**
 * The href of the login page's single "Sign in" button (the handoff start), or null when the
 * handoff is not configured; the page then falls back to the email + password form.
 */
export function studioSignInHref(): string | null {
  return process.env.CORE_BASE_URL?.trim() ? HANDOFF_START_PATH : null;
}

function stateCookieHeader(value: string, maxAge: number, secure: boolean): string {
  return `${HANDOFF_STATE_COOKIE}=${value}; Path=${COOKIE_PATH}; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

/** Set-Cookie header that removes the state cookie. */
export function clearStateCookie(secure: boolean): string {
  return stateCookieHeader("", 0, secure);
}

/**
 * Starts a handoff: a fresh state, the Set-Cookie header holding it with returnTo, and the Studio
 * URL to redirect to. Throws CoreConfigError when CORE_BASE_URL or APP_URL is missing.
 *
 * Binding the token to this browser: besides `state`, Studio receives `nonce` =
 * base64url(sha256(state)). CONTRACT FOR STUDIO (part B): /api/retail/v1/handoff must copy that
 * `nonce` query value unchanged into the token's `nonce` claim. The callback refuses a token whose
 * nonce is not the hash of the state in this browser's cookie, so a token minted for one browser's
 * handoff cannot be redeemed with another browser's state/cookie pair (login CSRF, token injection).
 */
export function startHandoff(
  returnTo: string | null | undefined,
  opts: { secure: boolean; appUrl?: string | null },
): { redirectTo: string; stateCookie: string } {
  const studio = coreConfig().baseUrl;
  // appUrl: the trusted origin of the address this browser is on (src/packs/hosts.ts); APP_URL otherwise.
  const app = (opts.appUrl ?? process.env.APP_URL)?.trim().replace(/\/+$/, "");
  if (!app) throw new CoreConfigError("APP_URL");

  const state = randomBytes(32).toString("base64url");
  const value = `${state}.${Buffer.from(safeReturnTo(returnTo), "utf8").toString("base64url")}`;
  const target = new URL(`${studio}/api/retail/v1/handoff`);
  target.searchParams.set("return", `${app}${HANDOFF_CALLBACK_PATH}`);
  target.searchParams.set("state", state);
  target.searchParams.set("nonce", handoffNonce(state));
  return { redirectTo: target.toString(), stateCookie: stateCookieHeader(value, HANDOFF_STATE_MAX_AGE_SECONDS, opts.secure) };
}

const digest = (s: string) => createHash("sha256").update(s, "utf8").digest();

/** The nonce Studio must echo into the token for this state: base64url(sha256(state)). */
export function handoffNonce(state: string): string {
  return digest(state).toString("base64url");
}

/** True when the token's nonce is handoffNonce(state); compared in constant time. */
export function nonceMatches(nonce: string, state: string): boolean {
  return timingSafeEqual(digest(nonce), digest(handoffNonce(state)));
}

/**
 * Checks the state from the query against the state cookie (constant time). Returns the stored
 * returnTo (validated again) on a match, null otherwise.
 */
export function checkState(cookieValue: string | null | undefined, state: string | null | undefined): { returnTo: string } | null {
  if (!cookieValue || !state || cookieValue.length > 2048 || state.length > 256) return null;
  const dot = cookieValue.indexOf(".");
  if (dot <= 0) return null;
  const stored = cookieValue.slice(0, dot);
  if (!timingSafeEqual(digest(stored), digest(state))) return null;
  const encoded = cookieValue.slice(dot + 1);
  const returnTo = /^[A-Za-z0-9_-]*$/.test(encoded) ? Buffer.from(encoded, "base64url").toString("utf8") : "";
  return { returnTo: safeReturnTo(returnTo) };
}

/** A 302 to `location` carrying the given Set-Cookie headers; never cached. */
export function handoffRedirect(location: string, setCookies: string[] = []): Response {
  const headers = new Headers({ Location: location, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  for (const c of setCookies) headers.append("Set-Cookie", c);
  return new Response(null, { status: 302, headers });
}
