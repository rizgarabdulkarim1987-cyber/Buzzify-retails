"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/server/auth/auth";
import { WORKPLACE_COOKIE } from "./_lib/workplace";

/** Ends the session and forgets the chosen workplace. */
export async function signOut(): Promise<void> {
  try {
    await auth.api.signOut({ headers: await headers() });
  } catch {
    // Already signed out: nothing to end.
  }
  (await cookies()).delete(WORKPLACE_COOKIE);
  redirect("/login");
}
