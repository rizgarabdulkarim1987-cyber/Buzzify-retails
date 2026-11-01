"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { isPlatformAdmin } from "@/server/admin/platform-admin";
import { signInThrottled } from "@/server/auth/login-throttle";

export type SignInState = { failed: null | "INVALID_CREDENTIALS" | "THROTTLED"; email: string };

/**
 * Email + password sign-in, throttled per email and per client address. The messages never say
 * whether the account exists.
 */
export async function signIn(_prev: SignInState, formData: FormData): Promise<SignInState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  if (email === "" || password === "") return { failed: "INVALID_CREDENTIALS", email };

  const result = await signInThrottled({ email, password }, await headers());
  if (!result.ok) return { failed: result.reason, email };
  redirect((await isPlatformAdmin(result.userId)) ? "/admin" : "/retail/home");
}
