import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { isPlatformAdmin } from "@/server/admin/platform-admin";
import { getSessionUserId } from "@/server/auth/auth";
import { getI18n } from "../../_lib/i18n";
import { AuthCard } from "../../login/auth-card";
import { PasswordForm } from "../../login/login-form";

export const metadata: Metadata = { robots: { index: false, follow: false } };

/**
 * Email + password sign-in for platform admins and support staff. Nothing on the public /login page
 * links here; the throttled sign-in action is the same one /login uses when there is no handoff.
 */
export default async function AdminLoginPage() {
  const userId = await getSessionUserId(await headers());
  if (userId) redirect((await isPlatformAdmin(userId)) ? "/admin" : "/retail/home");
  const { locale, t } = await getI18n();
  return (
    <AuthCard locale={locale} t={t} intro={t.auth.intro}>
      <PasswordForm
        labels={{
          email: t.auth.email,
          password: t.auth.password,
          submit: t.auth.submit,
          failed: t.auth.failed,
          throttled: t.auth.throttled,
          loading: t.common.loading,
        }}
      />
    </AuthCard>
  );
}
