import Link from "next/link";
import { redirect } from "next/navigation";
import { can } from "@/server/domain/permissions";
import { getI18n } from "../../_lib/i18n";
import { BarcodeIcon, PackageIcon, SparkIcon, StockIcon } from "../../_ui/icons";
import { StateBlock } from "../../_ui/state";
import { requireShell } from "../_shell";
import { aiSettingsLink, scanEntry, scanRole } from "../catalog/scan/_lib/rules";
import { loadAiStatus } from "../stock/receive/photo/_lib/load";

export default async function RetailHomePage() {
  const shell = await requireShell();
  const { t } = await getI18n();

  // A business that refuses this user (deactivated, closed) is shown here, not bounced around.
  if (shell.options && !shell.options.ok) {
    return (
      <main className="page">
        {shell.options.code === "READ_ONLY" ? (
          <StateBlock kind="alert" title={t.access.closedTitle} body={t.access.closedBody} testId="state-closed" />
        ) : (
          <StateBlock kind="locked" title={t.access.noPermissionTitle} body={t.access.noPermissionBody} testId="state-forbidden" />
        )}
      </main>
    );
  }
  if (!shell.branch) redirect("/retail/select");
  const canSetUp = shell.options?.ok === true && can(shell.options.value.role, "staff.manage");
  const canViewStock = shell.options?.ok === true && can(shell.options.value.role, "stock.view");
  // Scanning follows the catalog roles only; the AI settings card also needs the AI status (read
  // only for the owner and the manager, who are the only ones it could show to).
  const role = shell.options?.ok === true ? scanRole(shell.options.value.role) : null;
  const showScan = role !== null && scanEntry(role) === "SHOW";
  const wantsAi = role !== null && shell.businessId !== null && (role.isOwner || (role.isManager && role.canUseAi));
  const aiStatus = wantsAi ? await loadAiStatus({ userId: shell.user.id, businessId: shell.businessId!, idempotencyKey: "" }) : "UNAVAILABLE";
  const showAiSettings = role !== null && aiSettingsLink(role, aiStatus) === "SHOW";

  return (
    <main className="page">
      <div className="page-head">
        <div className="title-row">
          <h1>{t.home.title}</h1>
          {canSetUp ? (
            <Link href="/retail/setup" className="btn btn-secondary" data-testid="open-setup" style={{ marginInlineStart: "auto" }}>
              {t.setup.openFromHome}
            </Link>
          ) : null}
        </div>
      </div>
      <nav aria-label={t.catalog.title} className="home-links">
        <Link href="/retail/catalog" className="business-link" data-testid="open-catalog">
          <PackageIcon />
          <strong>{t.catalog.title}</strong>
          <span className="muted">{t.catalog.homeCardBody}</span>
        </Link>
        {canViewStock ? (
          <Link href="/retail/stock" className="business-link" data-testid="open-stock">
            <StockIcon />
            <strong>{t.stock.title}</strong>
            <span className="muted">{t.stock.homeCardBody}</span>
          </Link>
        ) : null}
        {showScan ? (
          <Link href="/retail/catalog/scan" className="business-link" data-testid="open-scan">
            <BarcodeIcon />
            <strong>{t.catalog.scan.title}</strong>
            <span className="muted">{t.catalog.scan.homeCardBody}</span>
          </Link>
        ) : null}
        {showAiSettings ? (
          <Link href="/retail/settings/ai" className="business-link" data-testid="open-ai-settings">
            <SparkIcon />
            <strong>{t.aiSettings.title}</strong>
            <span className="muted">{t.aiSettings.homeCardBody}</span>
          </Link>
        ) : null}
      </nav>
      <StateBlock
        kind="empty"
        title={t.home.emptyTitle}
        body={t.home.emptyBody}
        testId="state-home-empty"
        action={
          <Link href="/retail/select" className="btn btn-secondary">
            {t.header.switchBranch}
          </Link>
        }
      />
    </main>
  );
}
