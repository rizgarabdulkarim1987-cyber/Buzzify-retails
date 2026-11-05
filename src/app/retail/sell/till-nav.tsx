import Link from "next/link";
import type { ComponentType } from "react";
import type { Messages } from "@/messages";
import { CartIcon, DrawerIcon, PackageIcon, StockIcon, UserIcon } from "../../_ui/icons";
import { ExpensesIcon, ReportsIcon, SettingsIcon, SuppliersIcon } from "./_lib/nav-icons";

type Key = keyof Messages["till"]["nav"];

/*
 * The shop's sections, so the till reads as one part of a whole shop app. Entries that exist link to
 * their screen; the others are shown plainly as "soon" (no link, no data) until they are built.
 */
const SECTIONS: { key: Exclude<Key, "label" | "soon">; href: string | null; Icon: ComponentType }[] = [
  { key: "sell", href: "/retail/sell", Icon: CartIcon },
  { key: "shift", href: "/retail/sell/close", Icon: DrawerIcon },
  { key: "expenses", href: null, Icon: ExpensesIcon },
  { key: "suppliers", href: null, Icon: SuppliersIcon },
  { key: "customers", href: null, Icon: UserIcon },
  { key: "reports", href: null, Icon: ReportsIcon },
  { key: "stock", href: "/retail/stock", Icon: StockIcon },
  { key: "items", href: "/retail/catalog", Icon: PackageIcon },
  { key: "setup", href: "/retail/setup", Icon: SettingsIcon },
];

export function TillNav({ t, variant, onNavigate }: { t: Messages; variant: "rail" | "list"; onNavigate?: () => void }) {
  const n = t.till.nav;
  const id = variant === "rail" ? "nav" : "menu-nav";
  return (
    <nav className="till-nav" data-variant={variant} aria-label={n.label}>
      <ul>
        {SECTIONS.map(({ key, href, Icon }) => (
          <li key={key}>
            {href === null ? (
              <span className="till-nav-item" aria-disabled="true" data-soon="" data-testid={`${id}-${key}`}>
                <Icon />
                <span className="till-nav-label">{n[key]}</span>
                <small>{n.soon}</small>
              </span>
            ) : (
              <Link href={href} className="till-nav-item" aria-current={key === "sell" ? "page" : undefined} onClick={onNavigate} data-testid={`${id}-${key}`}>
                <Icon />
                <span className="till-nav-label">{n[key]}</span>
              </Link>
            )}
          </li>
        ))}
      </ul>
    </nav>
  );
}
