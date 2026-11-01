import Link from "next/link";
import { formatNumber } from "@/messages";
import { listExpiring } from "@/server/stock/queries";
import { fill } from "../../../_lib/format";
import { getI18n } from "../../../_lib/i18n";
import { StateBlock } from "../../../_ui/state";
import { RefusedPage } from "../../catalog/_lib/state-pages";
import { loadStockAccess } from "../_lib/access";
import { expiringDto } from "../_lib/format";
import { ExpiringTable, ReadOnlyBanner } from "../_lib/views";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** The periods offered besides each product's own alert days. */
const WINDOWS = [7, 30, 60, 90] as const;

export default async function ExpiringPage({ searchParams }: { searchParams: SearchParams }) {
  const { locale, t } = await getI18n();
  const access = await loadStockAccess();
  if (!access.ok) return <RefusedPage code={access.code} t={t} />;
  const e = t.stock.expiring;
  const raw = (await searchParams).days;
  const days = typeof raw === "string" && (WINDOWS as readonly number[]).includes(Number(raw)) ? Number(raw) : null;

  const found = await listExpiring(days === null ? {} : { withinDays: days }, access.meta);
  if (!found.ok) {
    return (
      <main className="page">
        <StateBlock kind="alert" title={t.common.errorTitle} body={t.errors[found.code]} testId="state-error" />
      </main>
    );
  }
  const rows = found.value.rows.map(expiringDto);

  return (
    <main className="page">
      <div className="page-head">
        <div className="title-row">
          <h1>{e.title}</h1>
          <Link href="/retail/stock" className="btn btn-secondary catalog-add">
            {e.back}
          </Link>
        </div>
        <p>{e.intro}</p>
      </div>
      {access.readOnly ? <ReadOnlyBanner t={t} /> : null}

      {/* A plain GET form: works before the page is interactive and keeps the choice in the address. */}
      <form className="stock-window" method="get" action="/retail/stock/expiring">
        <label className="field">
          <span>{e.window}</span>
          <select className="input" name="days" defaultValue={days === null ? "" : String(days)} data-testid="expiring-window">
            <option value="">{e.windowDefault}</option>
            {WINDOWS.map((d) => (
              <option key={d} value={d}>
                {fill(e.windowDays, { days: formatNumber(locale, d) })}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="btn btn-secondary">
          {e.apply}
        </button>
      </form>

      <section className="section" aria-labelledby="expiring-list">
        <div className="section-head">
          <h2 id="expiring-list">{e.list}</h2>
          {rows.length > 0 ? <span className="muted">{fill(e.count, { count: formatNumber(locale, rows.length) })}</span> : null}
        </div>
        {rows.length === 0 ? (
          <StateBlock kind="empty" title={e.emptyTitle} body={e.emptyBody} testId="expiring-empty" />
        ) : (
          <ExpiringTable locale={locale} t={t} rows={rows} />
        )}
      </section>
    </main>
  );
}
