"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { formatNumber, type Locale, type Messages } from "@/messages";
import { fill, pickName } from "../../_lib/format";
import { lineTotal, type CartLine, type Currency, type SellItemDto } from "./_lib/cart";
import { pageOf, pageSlots, pageWindow } from "./_lib/pager";
import { localQuantity, money } from "./_lib/views";

/*
 * The sale's lines as a wide table with fixed rows: the page holds as many whole rows as fit and the
 * header arrows turn the pages, so the screen never scrolls however long the sale is. A search shows its
 * matches in the same rows (tap one to add it). The page follows the selected line.
 */

export const ROW_REM = 2.875;

const DAY_MS = 86_400_000;

/** Days from today to an ISO date (negative once passed), or null. */
export function daysUntil(isoDate: string | null, now = Date.now()): number | null {
  if (!isoDate) return null;
  const t = Date.parse(`${isoDate}T00:00:00Z`);
  return Number.isNaN(t) ? null : Math.ceil((t - now) / DAY_MS);
}

/** Stock in the line's own unit (the till's stock is base units x 1000). */
export function stockIn(item: Pick<SellItemDto, "onHand" | "factor" | "quantityScale">): number | null {
  if (item.onHand === null) return null;
  const units = Number(item.onHand) / 1000 / item.factor;
  const p = 10 ** item.quantityScale;
  return Math.floor(units * p) / p;
}

type StockChipProps = { locale: Locale; t: Messages; item: SellItemDto | undefined };

export function StockChip({ locale, t, item }: StockChipProps) {
  const n = item ? stockIn(item) : null;
  if (n === null) return <span className="ot-chip">—</span>;
  if (n <= 0) return <span className="ot-chip" data-tone="bad">{t.till.one.out}</span>;
  return (
    <span className="ot-chip" data-tone={n <= 10 ? "warn" : "ok"}>
      {formatNumber(locale, n)}
    </span>
  );
}

export function ExpiryChip({ locale, t, item }: StockChipProps) {
  const d = item ? daysUntil(item.earliestExpiry) : null;
  if (d === null) return <span className="ot-chip">—</span>;
  if (d < 0) return <span className="ot-chip" data-tone="bad">{t.till.one.expired}</span>;
  if (d <= 30) return <span className="ot-chip" data-tone="bad">{fill(t.till.one.inDays, { n: formatNumber(locale, d) })}</span>;
  return <span className="ot-chip">{item!.earliestExpiry!.replaceAll("-", "/")}</span>;
}

type Props = {
  locale: Locale;
  t: Messages;
  currency: Currency;
  lines: readonly CartLine[];
  /** Stock and expiry of a line's item (known for items added in this session), or undefined. */
  infoOf: (line: CartLine) => SellItemDto | undefined;
  selectedKey: string | null;
  onSelect: (key: string) => void;
  onStep: (key: string, d: 1 | -1) => void;
  onRemove: (key: string) => void;
  /** A search's matches, shown in place of the lines; null when not searching. */
  results: readonly SellItemDto[] | null;
  searchText: string;
  onAddResult: (item: SellItemDto) => void;
  emptyText: string;
  noMatchText: string;
};

export function LineTable({ locale, t, currency, lines, infoOf, selectedKey, onSelect, onStep, onRemove, results, searchText, onAddResult, emptyText, noMatchText }: Props) {
  const one = t.till.one;
  const rowsRef = useRef<HTMLDivElement>(null);
  const [slots, setSlots] = useState(8);
  useLayoutEffect(() => {
    const el = rowsRef.current;
    if (!el) return;
    const measure = () => {
      const rowPx = parseFloat(getComputedStyle(document.documentElement).fontSize) * ROW_REM;
      setSlots(pageSlots(el.clientHeight, rowPx));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const m = (v: bigint | string) => money({ locale, t }, currency, v);
  const searching = results !== null;
  const selIndex = Math.max(0, lines.findIndex((l) => l.key === selectedKey));
  const pages = Math.max(1, Math.ceil(lines.length / slots));
  const page = Math.min(pageOf(selIndex, slots), pages - 1);
  const shownLines = pageWindow(lines, page, slots);
  const goPage = (p: number) => {
    const target = lines[Math.min(lines.length - 1, Math.max(0, p) * slots)];
    if (target) onSelect(target.key);
  };

  const head = [
    searching || pages <= 1 ? "#" : fill(one.pageOf, { n: formatNumber(locale, page + 1), total: formatNumber(locale, pages) }),
    t.till.colItem,
    one.colStock,
    one.colExpiry,
    t.till.colQty,
    t.till.colPrice,
    t.sell.total,
  ];

  return (
    <section className="ot-card ot-table" aria-label={t.till.ticket} data-testid="sell-cart">
      <div className="ot-thead" aria-hidden={false}>
        {head.map((h, i) => (
          <span key={i}>{h}</span>
        ))}
        <span className="ot-pg">
          {!searching && pages > 1 ? (
            <>
              <button type="button" onClick={() => goPage(page - 1)} disabled={page <= 0} aria-label={one.prevPage} data-testid="page-prev">
                ›
              </button>
              <button type="button" onClick={() => goPage(page + 1)} disabled={page >= pages - 1} aria-label={one.nextPage} data-testid="page-next">
                ‹
              </button>
            </>
          ) : null}
        </span>
      </div>
      <div className="ot-rows" ref={rowsRef} data-testid="line-rows">
        {searching ? (
          results.length === 0 ? (
            <div className="ot-empty">{fill(noMatchText, { q: searchText })}</div>
          ) : (
            results.slice(0, slots).map((it, i) => (
              <div key={`${it.variantId}:${it.unitId}`} className="ot-row" role="button" tabIndex={0} onClick={() => onAddResult(it)} onKeyDown={(e) => e.key === "Enter" && onAddResult(it)} data-testid="result-row">
                <span className="num">{formatNumber(locale, i + 1)}</span>
                <span className="nm">
                  {pickName(locale, it)}
                  <small>{it.unitName}</small>
                </span>
                <span className="num"><StockChip locale={locale} t={t} item={it} /></span>
                <span><ExpiryChip locale={locale} t={t} item={it} /></span>
                <span className="num ot-add">{one.clickToAdd}</span>
                <span />
                <span className="tot">{it.priceMinor === null ? t.sell.noPrice : m(it.priceMinor)}</span>
                <span />
              </div>
            ))
          )
        ) : lines.length === 0 ? (
          <div className="ot-empty" data-testid="cart-empty">
            {emptyText}
          </div>
        ) : (
          shownLines.map((l, k) => {
            const i = page * slots + k;
            const info = infoOf(l);
            const name = pickName(locale, l);
            const over = info !== undefined && stockIn(info) !== null && Number(l.quantity) > (stockIn(info) ?? 0);
            return (
              <div key={l.key} className="ot-row" aria-selected={l.key === selectedKey} onClick={() => onSelect(l.key)} data-testid="cart-row">
                <span className="num">{formatNumber(locale, i + 1)}</span>
                <span className="nm">
                  {name}
                  <small>{over ? one.qtyMore : l.unitName}</small>
                </span>
                <span className="num"><StockChip locale={locale} t={t} item={info} /></span>
                <span><ExpiryChip locale={locale} t={t} item={info} /></span>
                <span className="ot-step">
                  <button type="button" onClick={(e) => { e.stopPropagation(); onStep(l.key, -1); }} aria-label={fill(t.sell.decrease, { name })} data-testid="row-minus">
                    −
                  </button>
                  <span>{localQuantity(locale, l.quantity)}</span>
                  <button type="button" onClick={(e) => { e.stopPropagation(); onStep(l.key, 1); }} aria-label={fill(t.sell.increase, { name })} data-testid="row-plus">
                    +
                  </button>
                </span>
                <span className="num">{m(l.priceMinor)}</span>
                <span className="tot">{m(lineTotal(l))}</span>
                <span>
                  <button type="button" className="ot-x" onClick={(e) => { e.stopPropagation(); onRemove(l.key); }} aria-label={`${t.till.fnVoid}: ${name}`} data-testid="row-remove">
                    ×
                  </button>
                </span>
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}
