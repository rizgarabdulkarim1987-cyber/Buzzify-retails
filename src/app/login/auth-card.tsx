import type { ReactNode } from "react";
import type { Locale, Messages } from "@/messages";
import type { ProductBrand } from "@/packs/brand";
import { LocaleSwitcher } from "../_ui/locale-switcher";
import { ThemeSwitch } from "../_ui/theme-switch";
import { Wordmark } from "../_ui/wordmark";

/**
 * The sign-in card shared by /login and the staff-only /admin/login. `product` (a product address)
 * puts that product in the wordmark and the heading; without it the card shows "Buzzify Retails".
 */
export function AuthCard({
  locale,
  t,
  intro,
  children,
  product,
}: {
  locale: Locale;
  t: Messages;
  intro: string | null;
  children: ReactNode;
  product?: { brand: ProductBrand; heading: string };
}) {
  return (
    <main className="auth-page">
      <div className="auth-card">
        <div className="auth-top">
          {product ? (
            <Wordmark brand={product.brand.brand} word={product.brand.word} />
          ) : (
            <span className="wordmark" dir="ltr">
              Buzzify <span>Retails</span>
            </span>
          )}
          <LocaleSwitcher
            locale={locale}
            label={t.locale.label}
            names={{ ar: t.locale.ar, ckb: t.locale.ckb, en: t.locale.en }}
            tone="light"
          />
          <ThemeSwitch labels={t.theme} />
        </div>
        <div className="panel">
          <h1>{product ? product.heading : t.auth.title}</h1>
          {intro ? <p className="muted panel-intro">{intro}</p> : null}
          {children}
        </div>
      </div>
    </main>
  );
}
