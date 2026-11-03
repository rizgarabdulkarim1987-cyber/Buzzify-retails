import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { isPlatformAdmin } from "@/server/admin/platform-admin";
import { getSessionUserId } from "@/server/auth/auth";
import { studioSignInHref } from "@/server/core/handoff";
import { getI18n } from "../_lib/i18n";
import { AuthCard } from "./auth-card";
import { LoginForm } from "./login-form";

/** The public sign-in: one "Sign in" button (the handoff), or the password form when there is none. */
export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string | string[] }> }) {
  const { error } = await searchParams;
  const userId = await getSessionUserId(await headers());
  if (userId) redirect((await isPlatformAdmin(userId)) ? "/admin" : "/retail/home");
  const { locale, t } = await getI18n();
  const handoffHref = studioSignInHref();
  return (
    <AuthCard locale={locale} t={t} intro={handoffHref ? null : t.auth.intro}>
      <LoginForm
        labels={{
          email: t.auth.email,
          password: t.auth.password,
          submit: t.auth.submit,
          failed: t.auth.failed,
          throttled: t.auth.throttled,
          loading: t.common.loading,
          signIn: t.auth.signIn,
          coreFailed: t.auth.coreFailed,
        }}
        handoffHref={handoffHref}
        coreError={error === "core"}
      />
    </AuthCard>
  );
}
