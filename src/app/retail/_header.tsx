import Link from "next/link";
import type { Locale, Messages } from "@/messages";
import { BranchIcon, CartIcon, PackageIcon, SignOutIcon, StockIcon, StoreIcon, SwitchIcon, TerminalIcon, UserIcon } from "../_ui/icons";
import { LocaleSwitcher } from "../_ui/locale-switcher";
import { signOut } from "../session-actions";

type Props = {
  locale: Locale;
  t: Messages;
  business: string | null;
  branch: string | null;
  terminal: string | null;
  user: string;
  /** The user may see the stock screens (stock.view in the business shown). */
  canViewStock: boolean;
  /** The user may sell (sale.create) and a branch is chosen. */
  canSell?: boolean;
};

/**
 * The bar every retail screen carries: business, branch, terminal (when one is chosen) and user.
 * Long names are cut with an ellipsis (full text in the title tooltip) and never widen the page.
 */
export function ShellHeader({ locale, t, business, branch, terminal, user, canViewStock, canSell = false }: Props) {
  return (
    <header className="shell-header" data-testid="shell-header">
      <div className="bar">
        <div className="bar-business" title={business ?? undefined}>
          <StoreIcon />
          <span className="visually-hidden">{t.header.business}: </span>
          <span className="truncate" data-testid="header-business">
            {business ?? t.header.noBusiness}
          </span>
        </div>
        <div className="bar-actions">
          <LocaleSwitcher locale={locale} label={t.locale.label} names={{ ar: t.locale.ar, ckb: t.locale.ckb, en: t.locale.en }} />
          {canSell ? (
            <Link href="/retail/sell" className="bar-button" aria-label={t.sell.title} title={t.sell.title} data-testid="nav-sell">
              <CartIcon />
            </Link>
          ) : null}
          <Link href="/retail/catalog" className="bar-button" aria-label={t.catalog.title} title={t.catalog.title} data-testid="nav-catalog">
            <PackageIcon />
          </Link>
          {canViewStock ? (
            <Link href="/retail/stock" className="bar-button" aria-label={t.stock.title} title={t.stock.title} data-testid="nav-stock">
              <StockIcon />
            </Link>
          ) : null}
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
