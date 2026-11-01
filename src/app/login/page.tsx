import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { isPlatformAdmin } from "@/server/admin/platform-admin";
import { getSessionUserId } from "@/server/auth/auth";
import { studioSignInHref } from "@/server/core/handoff";
import { getI18n } from "../_lib/i18n";
import { LocaleSwitcher } from "../_ui/locale-switcher";
import { LoginForm } from "./login-form";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string | string[] }> }) {
  const { error } = await searchParams;
  const userId = await getSessionUserId(await headers());
  if (userId) redirect((await isPlatformAdmin(userId)) ? "/admin" : "/retail/home");
  const { locale, t } = await getI18n();
  return (
    <main className="auth-page">
      <div className="auth-card">
        <div className="auth-top">
          <span className="wordmark" dir="ltr">
            Buzzify <span>Retails</span>
          </span>
          <LocaleSwitcher
            locale={locale}
            label={t.locale.label}
            names={{ ar: t.locale.ar, ckb: t.locale.ckb, en: t.locale.en }}
            tone="light"
          />
        </div>
        <div className="panel">
          <h1>{t.auth.title}</h1>
          <p className="muted panel-intro">{t.auth.intro}</p>
          <LoginForm
            labels={{
              email: t.auth.email,
              password: t.auth.password,
              submit: t.auth.submit,
              failed: t.auth.failed,
              throttled: t.auth.throttled,
              loading: t.common.loading,
              studio: t.auth.studio,
              or: t.auth.or,
              coreFailed: t.auth.coreFailed,
            }}
            studioHref={studioSignInHref()}
            coreError={error === "core"}
          />
        </div>
      </div>
    </main>
  );
}
