"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { isPlatformAdmin } from "@/server/admin/platform-admin";
import { auth } from "@/server/auth/auth";

export type SignInState = { failed: boolean; email: string };

/** Email + password sign-in. Any failure shows one generic message (no account enumeration). */
export async function signIn(_prev: SignInState, formData: FormData): Promise<SignInState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  if (email === "" || password === "") return { failed: true, email };

  let userId: string;
  try {
    const result = await auth.api.signInEmail({ body: { email, password }, headers: await headers() });
    userId = result.user.id;
  } catch {
    return { failed: true, email };
  }
  redirect((await isPlatformAdmin(userId)) ? "/admin" : "/retail/home");
}
