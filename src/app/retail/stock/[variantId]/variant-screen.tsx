"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { formatDay, formatNumber, type Locale, type Messages } from "@/messages";
import { fill, formatMoney } from "../../../_lib/format";
import { Notice } from "../../../_ui/state";
import { listMovementsAction } from "../actions";
import { AdjustDialog } from "../adjust-dialog";
import { breakdownText, formatQty } from "../_lib/format";
import type { AdjustDone, BatchDto, BreakdownDto, Currency, ExpiryState, MovementDto } from "../_lib/types";
import { BatchList, ExpiryBadge, MovementTable } from "../_lib/views";

export type VariantTotal = {
  qty: string;
  availableQty: string;
  breakdown: BreakdownDto;
  nearestExpiry: string | null;
  status: ExpiryState;
  valueMinor?: string;
  avgUnitCostMinor?: string;
};

type Initial = { rows: MovementDto[]; nextCursor: string | null };

type Props = {
  locale: Locale;
  t: Messages;
  variantId: string;
  item: { productId: string; name: string; sku: string };
  currency: Currency;
  canSeeCost: boolean;
  canAdjust: boolean;
  readOnly: boolean;
  total: VariantTotal;
  batches: BatchDto[];
  initial: Initial;
};

/**
 * The variant's stock and its history. "Show older" follows the cursor. After an adjustment the
 * page data reloads (router.refresh in a transition): until it lands, the totals and the history
 * on screen are old, so the adjust button stays disabled while it is pending.
 */
export function VariantScreen({ locale, t, variantId, item, currency, canSeeCost, canAdjust, readOnly, total, batches, initial }: Props) {
  const m = t.stock.movement;
  const router = useRouter();
  const [refreshing, startTransition] = useTransition();
  const [page, setPage] = useState(initial);
  const [seen, setSeen] = useState(initial);
  const [loadingMore, setLoadingMore] = useState(false);
  const [failed, setFailed] = useState(false);
  const [adjusting, setAdjusting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // Fresh page data (after a refresh): start the history again from its newest page.
  if (seen !== initial) {
    setSeen(initial);
    setPage(initial);
  }
  const { rows, nextCursor } = page;

  const more = async () => {
    if (!nextCursor || loadingMore) return;
    const requested = nextCursor;
    setLoadingMore(true);
    setFailed(false);
    try {
      const r = await listMovementsAction({ variantId, cursor: requested });
      if (!r.ok) setFailed(true);
      else {
        // Appended only if the list is still the one this page follows (a refresh meanwhile starts it again).
        setPage((p) =>
          p.nextCursor === requested ? { rows: [...p.rows, ...r.value.rows.filter((x) => !p.rows.some((y) => y.id === x.id))], nextCursor: r.value.nextCursor } : p,
        );
      }
    } catch {
      setFailed(true);
    } finally {
      setLoadingMore(false);
    }
  };

  const onDone = (done: AdjustDone) => {
    setAdjusting(false);
    const parts = [fill(t.stock.adjust.done, { number: formatNumber(locale, done.number) })];
    if (done.costUnknown && canSeeCost) parts.push(t.stock.adjust.costUnknown);
    setNotice(parts.join(" "));
    startTransition(() => router.refresh());
  };

  const short = t.catalog.currencyShort[currency];
  const title = item.name;

  return (
    <>
      <div className="page-head">
        <div className="title-row">
          <h1 className="product-title" title={title}>
            {title}
          </h1>
          <div className="title-actions">
            {canAdjust ? (
              <button
                type="button"
                className="btn btn-primary"
                disabled={readOnly}
                aria-disabled={refreshing ? true : undefined}
                onClick={() => {
                  // While the page data reloads the button keeps focus (aria-disabled) but does nothing.
                  if (!refreshing) setAdjusting(true);
                }}
                data-testid="variant-adjust"
              >
                {t.stock.list.adjust}
              </button>
            ) : null}
            <Link href="/retail/stock" className="btn btn-secondary">
              {m.back}
            </Link>
          </div>
        </div>
        <p dir="ltr" className="muted variant-sku stock-sku-line">
          {t.stock.list.sku} {item.sku}
        </p>
      </div>

      <div aria-live="polite" role="status" className="visually-hidden">
        {refreshing ? t.stock.list.refreshing : ""}
      </div>
      {notice ? <Notice tone="success">{notice}</Notice> : null}

      <section className="section" aria-labelledby="stock-summary">
        <div className="section-head">
          <h2 id="stock-summary">{m.summary}</h2>
          <ExpiryBadge t={t} status={total.status} />
        </div>
        <dl className="stock-summary panel" aria-busy={refreshing || undefined} data-testid="variant-summary">
          <div>
            <dt>{m.onHand}</dt>
            <dd data-testid="variant-qty">{breakdownText(locale, t, total.breakdown)}</dd>
          </div>
          <div>
            <dt>{m.available}</dt>
            <dd>{fill(t.stock.qty.baseUnits, { qty: formatQty(locale, total.availableQty) })}</dd>
          </div>
          {total.nearestExpiry ? (
            <div>
              <dt>{m.nearestExpiry}</dt>
              <dd>{formatDay(locale, new Date(total.nearestExpiry))}</dd>
            </div>
          ) : null}
          {canSeeCost && total.valueMinor !== undefined ? (
            <div>
              <dt>{m.value}</dt>
              <dd data-testid="variant-value">{formatMoney(locale, currency, total.valueMinor, short)}</dd>
            </div>
          ) : null}
          {canSeeCost && total.avgUnitCostMinor !== undefined ? (
            <div>
              <dt>{m.avgCost}</dt>
              <dd>{formatMoney(locale, currency, total.avgUnitCostMinor, short)}</dd>
            </div>
          ) : null}
        </dl>
      </section>

      <section className="section" aria-labelledby="stock-batches">
        <div className="section-head">
          <h2 id="stock-batches">{m.batches}</h2>
        </div>
        <BatchList locale={locale} t={t} batches={batches} />
      </section>

      <section className="section" aria-labelledby="stock-history">
        <div className="section-head">
          <h2 id="stock-history">{m.history}</h2>
          <span className="muted">{m.inBaseUnits}</span>
        </div>
        {rows.length === 0 ? (
          <p className="muted" data-testid="movement-empty">
            {m.historyEmpty}
          </p>
        ) : (
          <div className="stock-movements-wrap" aria-busy={refreshing || loadingMore || undefined}>
            <MovementTable locale={locale} t={t} rows={rows} currency={currency} canSeeCost={canSeeCost} />
          </div>
        )}
        {failed ? <Notice tone="danger">{m.loadFailed}</Notice> : null}
        {nextCursor ? (
          <div className="catalog-more stock-more">
            <button type="button" className="btn btn-secondary" disabled={loadingMore || refreshing} aria-busy={loadingMore} onClick={() => void more()} data-testid="movement-load-more">
              {loadingMore ? m.loadingMore : m.loadMore}
            </button>
          </div>
        ) : null}
      </section>

      {adjusting ? (
        <AdjustDialog
          locale={locale}
          t={t}
          target={{ productId: item.productId, variantId, name: item.name }}
          onClose={() => setAdjusting(false)}
          onDone={onDone}
        />
      ) : null}
    </>
  );
}
