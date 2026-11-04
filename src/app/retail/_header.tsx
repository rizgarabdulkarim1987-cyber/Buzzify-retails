import Link from "next/link";
import type { Locale, Messages } from "@/messages";
import type { NavId } from "@/packs";
import type { ProductBrand } from "@/packs/brand";
import { BranchIcon, CartIcon, PackageIcon, SignOutIcon, StockIcon, StoreIcon, SwitchIcon, TerminalIcon, UserIcon } from "../_ui/icons";
import { LocaleSwitcher } from "../_ui/locale-switcher";
import { Wordmark } from "../_ui/wordmark";
import { signOut } from "../session-actions";

type Props = {
  locale: Locale;
  t: Messages;
  business: string | null;
  branch: string | null;
  terminal: string | null;
  user: string;
  /** The product this address or business belongs to (its wordmark). */
  product: ProductBrand;
  /** The pack's header sections the user may open (role and branch already checked), with the pack's words. */
  nav: { id: NavId; href: string; label: string }[];
};

const NAV_ICONS: Partial<Record<NavId, () => React.JSX.Element>> = { sell: CartIcon, catalog: PackageIcon, stock: StockIcon };

/**
 * The bar every retail screen carries: the product wordmark over the business, the pack's sections,
 * then branch, terminal (when one is chosen) and user. Long names are cut with an ellipsis (full
 * text in the title tooltip) and never widen the page.
 */
export function ShellHeader({ locale, t, business, branch, terminal, user, product, nav }: Props) {
  return (
    <header className="shell-header" data-testid="shell-header">
      <div className="bar">
        <div className="bar-business" title={business ?? undefined}>
          <StoreIcon />
          <div className="bar-titles">
            <Wordmark brand={product.brand} word={product.word} className="bar-wordmark" />
            <span className="visually-hidden">{t.header.business}: </span>
            <span className="truncate" data-testid="header-business">
              {business ?? t.header.noBusiness}
            </span>
          </div>
        </div>
        <div className="bar-actions">
          <LocaleSwitcher locale={locale} label={t.locale.label} names={{ ar: t.locale.ar, ckb: t.locale.ckb, en: t.locale.en }} />
          {nav.map((item) => {
            const Icon = NAV_ICONS[item.id] ?? PackageIcon;
            return (
              <Link key={item.id} href={item.href} className="bar-button" aria-label={item.label} title={item.label} data-testid={`nav-${item.id}`}>
                <Icon />
              </Link>
            );
          })}
          <Link href="/retail/select" className="bar-button" aria-label={t.header.switchBranch} title={t.header.switchBranch}>
            <SwitchIcon />
          </Link>
          <form action={signOut}>
            <button type="submit" className="bar-button" aria-label={t.common.signOut} title={t.common.signOut}>
              <SignOutIcon />
            </button>
          </form>
        </div>
      </div>
      <div className="context-strip">
        <dl className="context">
          <div>
            <dt>
              <BranchIcon />
              {t.header.branch}
            </dt>
            <dd className="truncate" title={branch ?? undefined} data-empty={branch === null} data-testid="header-branch">
              {branch ?? t.header.noBranch}
            </dd>
          </div>
          {terminal !== null ? (
            <div>
              <dt>
                <TerminalIcon />
                {t.header.terminal}
              </dt>
              <dd className="truncate" title={terminal} data-testid="header-terminal">
                {terminal}
              </dd>
            </div>
          ) : null}
          <div>
            <dt>
              <UserIcon />
              {t.header.user}
            </dt>
            <dd className="truncate" title={user} data-testid="header-user">
              {user}
            </dd>
          </div>
        </dl>
      </div>
    </header>
  );
}
