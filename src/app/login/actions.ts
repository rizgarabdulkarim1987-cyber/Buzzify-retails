"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { isPlatformAdmin } from "@/server/admin/platform-admin";
import { signInThrottled } from "@/server/auth/login-throttle";
import {
  chooseSignIn,
  codeSignIn,
  forwardedClientIp,
  parseSetCookie,
  passwordSignIn,
  type Shop,
  type SignInFailure,
  type StepOutcome,
} from "@/server/core/own-sign-in";
import { getCoreSignInClient } from "@/server/core/sign-in-client";

export type SignInState = { failed: null | "INVALID_CREDENTIALS" | "THROTTLED"; email: string };

/**
 * Email + password sign-in against local passwords (the staff-only /admin/login), throttled per
 * email and per client address. The messages never say whether the account exists.
 */
export async function signIn(_prev: SignInState, formData: FormData): Promise<SignInState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  if (email === "" || password === "") return { failed: "INVALID_CREDENTIALS", email };

  const result = await signInThrottled({ email, password }, await headers());
  if (!result.ok) return { failed: result.reason, email };
  redirect((await isPlatformAdmin(result.userId)) ? "/admin" : "/retail/home");
}

/** The /login form's state: which step shows, why the last one failed, and the shops to choose from. Never a password. */
export type AccountSignInState = { step: "password" | "code" | "choose"; failed: SignInFailure | null; email: string; shops: Shop[] };

/** Holds Studio's challenge between steps: HttpOnly, only sent to /login, gone after ten minutes. */
const STEP_COOKIE = "rt_signin_step";
const STEP_MAX_AGE = 600;

const initial = (email = ""): AccountSignInState => ({ step: "password", failed: null, email, shops: [] });

async function readStep(kind: "code" | "choose"): Promise<string | null> {
  const raw = (await cookies()).get(STEP_COOKIE)?.value ?? "";
  const prefix = `${kind}~`;
  return raw.startsWith(prefix) && raw.length <= 1100 ? raw.slice(prefix.length) : null;
}

async function keepStep(kind: "code" | "choose", challenge: string): Promise<void> {
  (await cookies()).set(STEP_COOKIE, `${kind}~${challenge}`, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/login",
    maxAge: STEP_MAX_AGE,
  });
}

async function dropStep(): Promise<void> {
  (await cookies()).set(STEP_COOKIE, "", { httpOnly: true, sameSite: "lax", path: "/login", maxAge: 0 });
}

async function signedIn(userId: string, setCookie: string | null, returnTo: string): Promise<never> {
  const jar = await cookies();
  if (setCookie) {
    const { name, value, options } = parseSetCookie(setCookie);
    jar.set(name, value, options);
  }
  await dropStep();
  redirect((await isPlatformAdmin(userId)) ? "/admin" : returnTo);
}

/** What the form shows after a step. A failed code keeps the code step; any other failure starts over. */
async function show(outcome: StepOutcome, from: AccountSignInState["step"], email: string, shops: Shop[]): Promise<AccountSignInState> {
  switch (outcome.kind) {
    case "signedIn":
      return signedIn(outcome.userId, outcome.setCookie, outcome.returnTo);
    case "code":
      await keepStep("code", outcome.challenge);
      return { step: "code", failed: null, email, shops: [] };
    case "choose":
      await keepStep("choose", outcome.challenge);
      return { step: "choose", failed: null, email, shops: outcome.shops };
    case "failed":
      if (outcome.reason === "INVALID_CODE" && from === "code") return { step: "code", failed: outcome.reason, email, shops };
      await dropStep();
      return { ...initial(email), failed: outcome.reason };
  }
}

/**
 * The public /login form. With Studio configured, every step is checked by Studio server to
 * server (src/server/core/own-sign-in.ts): the password, then a two-factor code when the account
 * has one, then the shop when an owner has several. Without it (a development or test setup) the
 * password is checked against local accounts, as /admin/login does.
 */
export async function signInWithAccount(prev: AccountSignInState, formData: FormData): Promise<AccountSignInState> {
  const intent = String(formData.get("intent") ?? "password");
  const email = String(formData.get("email") ?? prev.email ?? "").trim().slice(0, 254);
  if (formData.get("restart") !== null) {
    await dropStep();
    return initial(email);
  }

  const client = getCoreSignInClient();
  if (!client) {
    const password = String(formData.get("password") ?? "");
    if (email === "" || password === "") return { ...initial(email), failed: "INVALID_CREDENTIALS" };
    const result = await signInThrottled({ email, password }, await headers());
    if (!result.ok) return { ...initial(email), failed: result.reason };
    return signedIn(result.userId, null, "/retail/home");
  }

  const h = await headers();
  const meta = { clientIp: forwardedClientIp(h), userAgent: h.get("user-agent")?.slice(0, 512) || undefined };

  if (intent === "code") {
    const challenge = await readStep("code");
    if (!challenge) return show({ kind: "failed", reason: "EXPIRED" }, "code", email, []);
    const code = String(formData.get("code") ?? "").slice(0, 64);
    if (code.trim() === "") return { step: "code", failed: "INVALID_CODE", email, shops: [] };
    return show(await codeSignIn(client, { challenge, code }, meta), "code", email, []);
  }

  if (intent === "choose") {
    const challenge = await readStep("choose");
    const shopId = String(formData.get("shop") ?? "").slice(0, 64);
    if (!challenge || shopId === "") return show({ kind: "failed", reason: "EXPIRED" }, "choose", email, []);
    return show(await chooseSignIn(client, { challenge, shopId }, meta), "choose", email, prev.shops);
  }

  const password = String(formData.get("password") ?? "");
  if (email === "" || password === "") return { ...initial(email), failed: "INVALID_CREDENTIALS" };
  return show(await passwordSignIn(client, { email, password }, meta), "password", email, []);
}
