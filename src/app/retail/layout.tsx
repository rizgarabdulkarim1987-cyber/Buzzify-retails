import type { Metadata } from "next";
import type { ReactNode } from "react";
import { packById, packWords, visibleNav } from "@/packs";
import { productBrand } from "@/packs/brand";
import { can } from "@/server/domain/permissions";
import { currentHost } from "../_lib/host";
import { getI18n } from "../_lib/i18n";
import { loadShell, requireShell } from "./_shell";
import { ShellHeader } from "./_header";

/** Every retail page title carries the product's name ("Buzzify Supermarket"). */
export async function generateMetadata(): Promise<Metadata> {
  const shell = await loadShell();
  const { locale } = await getI18n();
  // Signed out (e.g. right after sign-out), the address's own product still names the tab.
  const hostPack = (await currentHost()).packId;
  const name = productBrand(shell?.pack ?? (hostPack ? packById(hostPack) : null), locale).name;
  // absolute: the root layout's template would otherwise repeat the name ("X · X").
  return { title: { absolute: name, template: `%s · ${name}` } };
}

export default async function RetailLayout({ children }: { children: ReactNode }) {
  const shell = await requireShell();
  const { locale, t } = await getI18n();
  const businessName =
    (shell.options?.ok ? shell.options.value.business.name : null) ??
    shell.memberships.find((m) => m.businessId === shell.businessId)?.name ??
    null;
  const role = shell.options?.ok === true ? shell.options.value.role : null;
  const product = productBrand(shell.pack, locale);
  // The neutral shared address (no business chosen yet) still shows the shared screens' sections.
  const words = shell.pack ? packWords(shell.pack, locale).nav : null;
  const nav = shell.pack
    ? visibleNav(shell.pack, { can: (p) => role !== null && can(role, p), hasBranch: shell.branch !== null }, "bar").map((s) => ({
        id: s.id,
        href: s.route,
        label: words![s.id],
      }))
    : [{ id: "catalog" as const, href: "/retail/catalog", label: t.catalog.title }];
  return (
    <>
      <ShellHeader
        locale={locale}
        t={t}
        business={businessName}
        branch={shell.branch?.name ?? null}
        terminal={shell.terminal?.name ?? null}
        user={shell.user.name || shell.user.email}
        product={product}
        nav={nav}
      />
      {children}
    </>
  );
}
