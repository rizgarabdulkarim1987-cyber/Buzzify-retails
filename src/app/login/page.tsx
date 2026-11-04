import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { isPlatformAdmin } from "@/server/admin/platform-admin";
import { getSessionUserId } from "@/server/auth/auth";
import { HANDOFF_START_PATH, resetPasswordHref } from "@/server/core/handoff";
import { packById, packWords } from "@/packs";
import { productBrand } from "@/packs/brand";
import { currentHost } from "../_lib/host";
import { Wordmark } from "../_ui/wordmark";
import { getI18n } from "../_lib/i18n";
import { LocaleSwitcher } from "../_ui/locale-switcher";
import { AccountSignInForm } from "./login-form";

/** Sales, stock and shifts, each in its own language: the calm panel beside the form on wide screens. */
const LINES = [
  { lang: "en", dir: "ltr", text: "Sales, stock and shifts", name: "English" },
  { lang: "ar", dir: "rtl", text: "المبيعات والمخزون والورديات", name: "العربية" },
  { lang: "ckb", dir: "rtl", text: "فرۆشتن، کۆگا و شیفتەکان", name: "کوردی" },
] as const;

/**
 * The public sign-in: Retails' own email and password form (then a code or a business when the
 * account asks for one), checked by the account system server to server. The staff-only password
 * form lives on /admin/login and is never linked here. error=core: a browser handoff just failed.
 */
export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string | string[] }> }) {
  const { error } = await searchParams;
  const userId = await getSessionUserId(await headers());
  if (userId) redirect((await isPlatformAdmin(userId)) ? "/admin" : "/retail/home");
  const { locale, t } = await getI18n();
  const a = t.auth;
  // On a product address the page names that product; the shared address stays neutral.
  const { packId } = await currentHost();
  const pack = packId ? packById(packId) : null;
  const brand = productBrand(pack, locale);
  return (
    <div className="auth-split">
      <div className="auth-main">
        <header className="auth-top">
          <Wordmark brand={brand.brand} word={brand.word} />
          <LocaleSwitcher
            locale={locale}
            label={t.locale.label}
            names={{ ar: t.locale.ar, ckb: t.locale.ckb, en: t.locale.en }}
            tone="light"
          />
        </header>
        <main className="auth-body">
          <div className="auth-form">
            <h1 className="auth-title">{pack ? packWords(pack, locale).loginTitle : a.title}</h1>
            <AccountSignInForm
              labels={{
                email: a.email,
                password: a.password,
                submit: a.submit,
                failed: a.failed,
                throttled: a.throttled,
                loading: t.common.loading,
                forgot: a.forgot,
                showPassword: a.showPassword,
                hidePassword: a.hidePassword,
                codeIntro: a.codeIntro,
                code: a.code,
                codeSubmit: a.codeSubmit,
                codeFailed: a.codeFailed,
                expired: a.expired,
                startOver: a.startOver,
                chooseIntro: a.chooseIntro,
                chooseSubmit: a.chooseSubmit,
                notReady: a.notReady,
                preparing: a.preparing,
                unavailable: a.unavailable,
                elsewhere: a.elsewhere,
                elsewhereAction: a.elsewhereAction,
                coreFailed: a.coreFailed,
              }}
              forgotHref={resetPasswordHref()}
              elsewhereHref={HANDOFF_START_PATH}
              notice={error === "core" ? a.coreFailed : null}
            />
          </div>
        </main>
      </div>
      <aside className="auth-aside">
        <p className="auth-aside-intro">{a.aside}</p>
        <ul className="auth-lines">
          {LINES.map((line) => (
            <li key={line.lang} lang={line.lang}>
              <span dir={line.dir} className="auth-line">
                {line.text}
              </span>
              <span className="auth-line-name">{line.name}</span>
            </li>
          ))}
        </ul>
      </aside>
    </div>
  );
}
