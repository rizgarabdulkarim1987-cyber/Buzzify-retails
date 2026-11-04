import { z } from "zod";
import { signedCall } from "./client";

/*
 * Retails -> Studio, for the sign-in form on /login: Studio checks the email and password (and the
 * second step) and answers with a handoff token, signed like every other call (CORE_OUT_SECRET).
 * The password travels only in the signed POST body, over https in production (coreConfig refuses
 * plain http there); it is never logged, stored or put in a URL here. Errors are CoreClientError
 * (a class and an HTTP status only).
 *
 * The Studio contract (its src/server/retail/credentials.ts):
 *   POST /api/retail/v1/credentials            { email, password, clientIp, nonce, userAgent? }
 *   POST /api/retail/v1/credentials/two-factor { challenge, code, clientIp, nonce, userAgent? }
 *   POST /api/retail/v1/credentials/choose     { challenge, shopId, clientIp, nonce }
 * each answering 200 with one `status` (below), or 429 when a sign-in limit is reached.
 */

export const CREDENTIALS_PATH = "/api/retail/v1/credentials";
export const TWO_FACTOR_PATH = "/api/retail/v1/credentials/two-factor";
export const CHOOSE_PATH = "/api/retail/v1/credentials/choose";

const challenge = z.string().min(1).max(1024);

export const signInAnswerSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok"), handoffToken: z.string().min(1).max(4096) }),
  z.object({ status: z.literal("needs_2fa"), challenge }),
  z.object({
    status: z.literal("choose"),
    challenge,
    shops: z
      .array(z.object({ id: z.string().min(1).max(64), name: z.string().max(200), ready: z.boolean() }))
      .min(1)
      .max(100),
  }),
  z.object({ status: z.enum(["invalid", "invalid_code", "expired", "preparing", "unavailable", "throttled"]) }),
]);

export type SignInAnswer = z.infer<typeof signInAnswerSchema>;

/** What Retails forwards about the browser: trusted by Studio only because the call is signed. */
export type BrowserMeta = { clientIp: string; userAgent?: string };

export interface CoreSignInClient {
  checkPassword(input: { email: string; password: string; nonce: string } & BrowserMeta): Promise<SignInAnswer>;
  checkCode(input: { challenge: string; code: string; nonce: string } & BrowserMeta): Promise<SignInAnswer>;
  choose(input: { challenge: string; shopId: string; nonce: string; clientIp: string }): Promise<SignInAnswer>;
}

/** A 429 is an answer, not a failure: the sign-in limits were reached. */
const THROTTLED = { 429: { status: "throttled" as const } };

export function createHttpCoreSignInClient(): CoreSignInClient {
  return {
    checkPassword: (input) => signedCall("POST", CREDENTIALS_PATH, input, signInAnswerSchema, THROTTLED),
    checkCode: (input) => signedCall("POST", TWO_FACTOR_PATH, input, signInAnswerSchema, THROTTLED),
    choose: (input) => signedCall("POST", CHOOSE_PATH, input, signInAnswerSchema, THROTTLED),
  };
}

declare global {
  // Test-only override; never read in production.
  var __coreSignInFake: CoreSignInClient | undefined;
}

/** Installs (or, with undefined, removes) a test double for this process. */
export function setCoreSignInFake(client: CoreSignInClient | undefined): void {
  globalThis.__coreSignInFake = client;
}

/**
 * The configured client, or null when Studio is not configured (CORE_BASE_URL unset): /login then
 * checks local passwords as /admin/login does. A test fake wins outside production only.
 */
export function getCoreSignInClient(): CoreSignInClient | null {
  if (process.env.NODE_ENV !== "production" && globalThis.__coreSignInFake) return globalThis.__coreSignInFake;
  if (!process.env.CORE_BASE_URL?.trim()) return null;
  return createHttpCoreSignInClient();
}
