import { randomBytes } from "node:crypto";
import { completeHandoff } from "@/server/admin/core-handoff";
import { CoreClientError } from "./client";
import { DEFAULT_RETURN_TO, handoffNonce } from "./handoff";
import { signInAttempt } from "./rate-limit";
import type { BrowserMeta, CoreSignInClient, SignInAnswer } from "./sign-in-client";

/*
 * The /login form, signed in through Studio without leaving Retails. Each step:
 *   1. a client address, or no sign-in at all; then Retails' own counts, the same as Studio's
 *      (signInAttempt: 20 per address, and 5 per email for the password, per ten minutes), before
 *      Studio is asked;
 *   2. a fresh handoff state made here, on the server, whose nonce (base64url(sha256(state)))
 *      goes to Studio in the signed call; Studio mints the token with that nonce;
 *   3. an "ok" answer's token is redeemed at once by completeHandoff, the very code the browser
 *      handoff's callback runs: signature, 60 s lifetime, nonce bound to the state made in (2),
 *      jti spent once, user linked or created, a 12 h session opened. The state never leaves this
 *      server, so a token that leaks cannot be redeemed anywhere else.
 * The password is passed to Studio and dropped: never logged, stored, returned or put in a URL.
 * Logs carry a reason or an error class only.
 */

/**
 * ELSEWHERE: the password was right but Studio will not sign this account in through this form (a platform account, or
 * one the handoff's own rule turns away); the form sends the person to the browser handoff, Studio's own sign-in page.
 * UNAVAILABLE: Studio gave a token but this server would not open a session with it.
 */
export type SignInFailure =
  | "INVALID_CREDENTIALS"
  | "THROTTLED"
  | "INVALID_CODE"
  | "EXPIRED"
  | "PREPARING"
  | "UNAVAILABLE"
  | "ELSEWHERE"
  | "FAILED";
export type Shop = { id: string; name: string; ready: boolean };

export type StepOutcome =
  | { kind: "signedIn"; userId: string; setCookie: string; returnTo: string }
  | { kind: "code"; challenge: string }
  | { kind: "choose"; challenge: string; shops: Shop[] }
  | { kind: "failed"; reason: SignInFailure };

const ADDRESS = /^[0-9A-Fa-f:.]{1,64}$/;

/**
 * The browser's address to forward to Studio: the X-Forwarded-For entry the nearest proxy added
 * (the last, or TRUSTED_PROXY_HOPS entries from the end), as Studio reads its own visitors. The
 * first entry is whatever the browser wrote and could dodge the per-address limit. Next itself
 * fills X-Forwarded-For with the socket's peer when no proxy did, so it is there behind Caddy and
 * without it. X-Real-IP is not read: nothing in front of Retails is known to set it, so a browser
 * could. "" when there is no usable entry (then the form refuses to sign in).
 */
export function forwardedClientIp(headers: Headers): string {
  const entries = (headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);
  const configured = Number.parseInt(process.env.TRUSTED_PROXY_HOPS ?? "", 10);
  const hops = Number.isInteger(configured) && configured >= 1 ? configured : 1;
  if (entries.length < hops) return "";
  const ip = entries[entries.length - hops]!;
  return ADDRESS.test(ip) ? ip : "";
}

function freshState(): { state: string; nonce: string } {
  const state = randomBytes(32).toString("base64url");
  return { state, nonce: handoffNonce(state) };
}

const failed = (reason: SignInFailure): StepOutcome => ({ kind: "failed", reason });

async function redeem(token: string, state: string, meta: BrowserMeta): Promise<StepOutcome> {
  const stateCookie = `${state}.${Buffer.from(DEFAULT_RETURN_TO, "utf8").toString("base64url")}`;
  const outcome = await completeHandoff({ token, state, stateCookie, ipAddress: meta.clientIp, userAgent: meta.userAgent ?? "" });
  if (!outcome.ok) {
    console.warn(`[core.sign-in] refused: ${outcome.reason}`);
    return failed(outcome.reason === "ACCOUNT_CONFLICT" || outcome.reason === "BUSINESS" ? "UNAVAILABLE" : "FAILED");
  }
  return { kind: "signedIn", userId: outcome.userId, setCookie: outcome.setCookie, returnTo: outcome.returnTo };
}

async function settle(answer: SignInAnswer, state: string, meta: BrowserMeta): Promise<StepOutcome> {
  switch (answer.status) {
    case "ok":
      return redeem(answer.handoffToken, state, meta);
    case "needs_2fa":
      return { kind: "code", challenge: answer.challenge };
    case "choose":
      return { kind: "choose", challenge: answer.challenge, shops: answer.shops };
    case "invalid":
      return failed("INVALID_CREDENTIALS");
    case "invalid_code":
      return failed("INVALID_CODE");
    case "expired":
      return failed("EXPIRED");
    case "preparing":
      return failed("PREPARING");
    case "unavailable":
      return failed("ELSEWHERE");
    case "throttled":
      return failed("THROTTLED");
  }
}

/**
 * Runs one step: an address or nothing, the Retails-side counts, a fresh state, Studio's answer, then settle. Never
 * throws. Without an address the step is refused locally, generically: browsers that cannot be told apart never share
 * one count, and Studio is not asked.
 */
async function step(meta: BrowserMeta, email: string | undefined, ask: (nonce: string) => Promise<SignInAnswer>): Promise<StepOutcome> {
  try {
    if (!ADDRESS.test(meta.clientIp)) {
      console.warn("[core.sign-in] refused: no client address");
      return failed("FAILED");
    }
    if (!(await signInAttempt({ ip: meta.clientIp, email })).ok) return failed("THROTTLED");
    const { state, nonce } = freshState();
    return await settle(await ask(nonce), state, meta);
  } catch (err) {
    if (err instanceof CoreClientError) console.error(`[core.sign-in] studio: ${err.kind}${err.status ? ` ${err.status}` : ""}`);
    else console.error(`[core.sign-in] unexpected failure: ${err instanceof Error ? err.name : typeof err}`);
    return failed("FAILED");
  }
}

export function passwordSignIn(client: CoreSignInClient, input: { email: string; password: string }, meta: BrowserMeta): Promise<StepOutcome> {
  return step(meta, input.email, (nonce) => client.checkPassword({ email: input.email, password: input.password, nonce, ...meta }));
}

export function codeSignIn(client: CoreSignInClient, input: { challenge: string; code: string }, meta: BrowserMeta): Promise<StepOutcome> {
  return step(meta, undefined, (nonce) => client.checkCode({ challenge: input.challenge, code: input.code, nonce, ...meta }));
}

export function chooseSignIn(client: CoreSignInClient, input: { challenge: string; shopId: string }, meta: BrowserMeta): Promise<StepOutcome> {
  return step(meta, undefined, (nonce) => client.choose({ challenge: input.challenge, shopId: input.shopId, nonce, clientIp: meta.clientIp }));
}

/** A Set-Cookie line (openSession's) as the name, decoded value and options Next's cookies().set takes. */
export function parseSetCookie(line: string): {
  name: string;
  value: string;
  options: { path?: string; maxAge?: number; httpOnly?: boolean; secure?: boolean; sameSite?: "lax" | "strict" | "none"; domain?: string };
} {
  const [pair = "", ...attrs] = line.split(";").map((p) => p.trim());
  const eq = pair.indexOf("=");
  const options: ReturnType<typeof parseSetCookie>["options"] = {};
  for (const attr of attrs) {
    const [k = "", v = ""] = attr.split("=");
    const key = k.toLowerCase();
    if (key === "path") options.path = v;
    else if (key === "max-age") options.maxAge = Number(v);
    else if (key === "domain") options.domain = v;
    else if (key === "httponly") options.httpOnly = true;
    else if (key === "secure") options.secure = true;
    else if (key === "samesite") options.sameSite = v.toLowerCase() as "lax" | "strict" | "none";
  }
  return { name: pair.slice(0, eq), value: decodeURIComponent(pair.slice(eq + 1)), options };
}
