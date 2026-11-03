import Link from "next/link";
import { redirect } from "next/navigation";
import { can } from "@/server/domain/permissions";
import { getI18n } from "../../_lib/i18n";
import { BarcodeIcon, CartIcon, DrawerIcon, PackageIcon, SparkIcon, StockIcon, StoreIcon, SwitchIcon } from "../../_ui/icons";
import { StateBlock } from "../../_ui/state";
import { requireShell } from "../_shell";
import { aiSettingsLink, scanEntry, scanRole } from "../catalog/scan/_lib/rules";
import { loadAiStatus } from "../stock/receive/photo/_lib/load";

/**
 * Home. Whoever sells lands straight in the till (open shift, or the sale screen). The shop menu
 * (`?menu=1`, from the till's menu, and the home of anyone who does not sell) is four big tiles at
 * most: Sell, Items, Stock, Close shift; everything else sits under a small "More".
 */
export default async function RetailHomePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const shell = await requireShell();
  const { t } = await getI18n();
  const tl = t.till;

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
  const role = shell.options?.ok === true ? shell.options.value.role : null;
  const canSell = role !== null && can(role, "sale.create");
  if (canSell && (await searchParams).menu !== "1") redirect("/retail/sell");

  const canSetUp = role !== null && can(role, "staff.manage");
  const canViewStock = role !== null && can(role, "stock.view");
  // Scanning follows the catalog roles only; the AI settings link also needs the AI status (read
  // only for the owner and the manager, who are the only ones it could show to).
  const scan = role !== null ? scanRole(role) : null;
  const showScan = scan !== null && scanEntry(scan) === "SHOW";
  const wantsAi = scan !== null && shell.businessId !== null && (scan.isOwner || (scan.isManager && scan.canUseAi));
  const aiStatus = wantsAi ? await loadAiStatus({ userId: shell.user.id, businessId: shell.businessId!, idempotencyKey: "" }) : "UNAVAILABLE";
  const showAiSettings = scan !== null && aiSettingsLink(scan, aiStatus) === "SHOW";

  return (
    <main className="page shop-home">
      <h1 className="visually-hidden">{t.home.title}</h1>
      <nav aria-label={t.home.title} className="shop-tiles">
        {canSell ? (
          <Link href="/retail/sell" className="shop-tile shop-tile-go" data-testid="open-sell">
            <CartIcon />
            <strong>{tl.sellTile}</strong>
            <span>{tl.sellTileBody}</span>
          </Link>
        ) : null}
        <Link href="/retail/catalog" className="shop-tile" data-testid="open-catalog">
          <PackageIcon />
          <strong>{tl.itemsTile}</strong>
          <span>{tl.itemsTileBody}</span>
        </Link>
        {canViewStock ? (
          <Link href="/retail/stock" className="shop-tile" data-testid="open-stock">
            <StockIcon />
            <strong>{tl.stockTile}</strong>
            <span>{tl.stockTileBody}</span>
          </Link>
        ) : null}
        {canSell ? (
          <Link href="/retail/sell/close" className="shop-tile" data-testid="open-close">
            <DrawerIcon />
            <strong>{tl.closeTile}</strong>
            <span>{tl.closeTileBody}</span>
          </Link>
        ) : null}
      </nav>
      <details className="shop-more" data-testid="home-more">
        <summary>{tl.more}</summary>
        <ul>
          {canSetUp ? (
            <li>
              <Link href="/retail/setup" data-testid="open-setup">
                <StoreIcon />
                {tl.setup}
              </Link>
            </li>
          ) : null}
          {showScan ? (
            <li>
              <Link href="/retail/catalog/scan" data-testid="open-scan">
                <BarcodeIcon />
                {tl.scan}
              </Link>
            </li>
          ) : null}
          {showAiSettings ? (
            <li>
              <Link href="/retail/settings/ai" data-testid="open-ai-settings">
                <SparkIcon />
                {tl.aiSettings}
              </Link>
            </li>
          ) : null}
          <li>
            <Link href="/retail/select">
              <SwitchIcon />
              {tl.switchBranch}
            </Link>
          </li>
        </ul>
      </details>
    </main>
  );
}
