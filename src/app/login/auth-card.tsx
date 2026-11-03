import type { ReactNode } from "react";
import type { Locale, Messages } from "@/messages";
import { LocaleSwitcher } from "../_ui/locale-switcher";

/** The sign-in card shared by /login and the staff-only /admin/login. */
export function AuthCard({ locale, t, intro, children }: { locale: Locale; t: Messages; intro: string | null; children: ReactNode }) {
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
          {intro ? <p className="muted panel-intro">{intro}</p> : null}
          {children}
        </div>
      </div>
    </main>
  );
}
