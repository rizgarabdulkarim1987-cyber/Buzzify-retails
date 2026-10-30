import type { ReactNode } from "react";
import { can } from "@/server/domain/permissions";
import { getI18n } from "../_lib/i18n";
import { requireShell } from "./_shell";
import { ShellHeader } from "./_header";

export default async function RetailLayout({ children }: { children: ReactNode }) {
  const shell = await requireShell();
  const { locale, t } = await getI18n();
  const businessName =
    (shell.options?.ok ? shell.options.value.business.name : null) ??
    shell.memberships.find((m) => m.businessId === shell.businessId)?.name ??
    null;
  return (
    <>
      <ShellHeader
        locale={locale}
        t={t}
        business={businessName}
        branch={shell.branch?.name ?? null}
        terminal={shell.terminal?.name ?? null}
        user={shell.user.name || shell.user.email}
        canViewStock={shell.options?.ok === true && can(shell.options.value.role, "stock.view")}
      />
      {children}
    </>
  );
}
