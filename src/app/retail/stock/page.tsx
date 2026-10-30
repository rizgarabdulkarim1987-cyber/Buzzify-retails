import Link from "next/link";
import { listStock } from "@/server/stock/queries";
import { getI18n } from "../../_lib/i18n";
import { StateBlock } from "../../_ui/state";
import { RefusedPage } from "../catalog/_lib/state-pages";
import { loadStockAccess } from "./_lib/access";
import { stockRowDto } from "./_lib/format";
import { ReadOnlyBanner } from "./_lib/views";
import { StockBrowser } from "./stock-browser";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

export default async function StockPage({ searchParams }: { searchParams: SearchParams }) {
  const { locale, t } = await getI18n();
  const access = await loadStockAccess();
  if (!access.ok) return <RefusedPage code={access.code} t={t} />;
  const params = await searchParams;
  const query = one(params.q).slice(0, 100);
  const expiringOnly = one(params.expiring) === "1";

  const first = await listStock({ query, expiringOnly }, access.meta);
  if (!first.ok) {
    return (
      <main className="page">
        <StateBlock kind="alert" title={t.common.errorTitle} body={t.errors[first.code]} testId="state-error" />
      </main>
    );
  }
  const ctx = access.context;

  return (
    <main className="page">
      <div className="page-head">
        <div className="title-row">
          <h1>{t.stock.title}</h1>
          <div className="title-actions">
            <Link href="/retail/stock/expiring" className="btn btn-secondary" data-testid="stock-expiring-link">
              {t.stock.list.expiringPage}
            </Link>
          </div>
        </div>
      </div>
      {access.readOnly ? <ReadOnlyBanner t={t} /> : null}
      <StockBrowser
        locale={locale}
        t={t}
        currency={ctx.defaultCurrency}
        canSeeCost={ctx.canSeeCost}
        canAdjust={ctx.canAdjust}
        readOnly={access.readOnly}
        initial={{ query, expiringOnly, rows: first.value.rows.map(stockRowDto), nextCursor: first.value.nextCursor }}
      />
    </main>
  );
}
