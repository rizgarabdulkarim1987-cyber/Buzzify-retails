"use client";

import { useState } from "react";
import { formatNumber, formatTime, type Locale, type Messages } from "@/messages";
import { fill, pickName } from "../../_lib/format";
import { PrintIcon } from "../../_ui/icons";
import type { CartLine, Currency, ReceiptDto, SellItemDto, ShiftDto } from "./_lib/cart";
import { calcDisplay, calcPress, initialCalc } from "./_lib/calc";
import { money } from "./_lib/views";
import { daysUntil, stockIn } from "./line-table";

/* The cards around the table: shift total, the selected product (stock and batches with expiry), the last receipts, the calculator. */

type Common = { locale: Locale; t: Messages; currency: Currency };

export function ShiftCard({ locale, t, currency, shift }: Common & { shift: ShiftDto }) {
  const m = (v: bigint | string) => money({ locale, t }, currency, v);
  const usd = BigInt(shift.usdDinarMinor);
  return (
    <section className="ot-card ot-shift" aria-label={t.till.one.shiftTitle} data-testid="shift-card">
      <h2>
        <span>{t.till.one.shiftTitle}</span>
        <span>{fill(t.till.one.receipts, { n: formatNumber(locale, shift.salesCount) })}</span>
      </h2>
      <div className="ot-body">
        <div className="big" data-testid="shift-total">{m(shift.totalMinor)}</div>
        <div className="ot-chips">
          <span className="ot-chip">{t.till.payCash} {m(shift.cashMinor)}</span>
          <span className="ot-chip">{t.till.payCard} {m(shift.cardMinor)}</span>
          {usd > 0n ? <span className="ot-chip">$ {m(usd)}</span> : null}
        </div>
      </div>
    </section>
  );
}

export function ProductCard({ locale, t, line, item }: Common & { line: CartLine | null; item: SellItemDto | undefined }) {
  const one = t.till.one;
  const stock = item ? stockIn(item) : null;
  const tone = stock === null ? undefined : stock <= 0 ? "var(--color-danger)" : stock <= 10 ? "var(--color-warn)" : "var(--color-success)";
  return (
    <section className="ot-card ot-prod" aria-label={one.selected} data-testid="product-card">
      <h2>
        <span>{one.selected}</span>
      </h2>
      <div className="ot-body">
        {!line ? (
          <span className="ot-meta">{one.pickLine}</span>
        ) : (
          <>
            <div className="nm">{pickName(locale, line)}</div>
            <div className="stock">
              <span>{one.remaining}</span>
              <b style={{ color: tone }} data-testid="product-stock">{stock === null ? "—" : formatNumber(locale, stock)}</b>
            </div>
            <ul className="ot-batches" data-testid="product-batches">
              {item && item.batches.length > 0 ? (
                item.batches.map((b, i) => {
                  const d = daysUntil(b.expiryDate);
                  const qty = Math.floor((Number(b.qty) / 1000 / item.factor) * 10 ** item.quantityScale) / 10 ** item.quantityScale;
                  return (
                    <li key={i}>
                      <span>{b.expiryDate ? fill(one.expiresOn, { date: b.expiryDate.replaceAll("-", "/") }) : "—"}</span>
                      <span style={d !== null && d <= 30 ? { color: "var(--color-danger)", fontWeight: 700 } : undefined}>
                        {formatNumber(locale, qty)}
                        {d !== null ? ` · ${d < 0 ? one.expired : fill(one.inDays, { n: formatNumber(locale, d) })}` : ""}
                      </span>
                    </li>
                  );
                })
              ) : (
                <li>
                  <span>{one.noBatches}</span>
                </li>
              )}
            </ul>
          </>
        )}
      </div>
    </section>
  );
}

export function ReceiptsCard({ locale, t, currency, receipts }: Common & { receipts: readonly ReceiptDto[] }) {
  const m = (v: bigint | string) => money({ locale, t }, currency, v);
  return (
    <section className="ot-card ot-recent" aria-label={t.till.one.recent} data-testid="receipts-card">
      <h2>
        <span>{t.till.one.recent}</span>
      </h2>
      <ul className="ot-list">
        {receipts.length === 0 ? (
          <li>
            <small>{t.till.one.noReceipts}</small>
          </li>
        ) : (
          receipts.slice(0, 4).map((r) => (
            <li key={r.saleId} data-testid="receipt-row">
              <span>
                {formatNumber(locale, r.number)} <small>{formatTime(locale, new Date(r.postedAt))}</small>
              </span>
              <b>{m(r.totalMinor)}</b>
              <button type="button" className="ot-xs" onClick={() => window.print()} aria-label={t.sell.receipt.print}>
                <PrintIcon />
              </button>
            </li>
          ))
        )}
      </ul>
    </section>
  );
}

const KEYS: { k: string; label?: string; cls?: string }[] = [
  { k: "C", cls: "op" }, { k: "B", label: "⌫", cls: "op" }, { k: "%", cls: "op" }, { k: "/", label: "÷", cls: "op" },
  { k: "7" }, { k: "8" }, { k: "9" }, { k: "*", label: "×", cls: "op" },
  { k: "4" }, { k: "5" }, { k: "6" }, { k: "-", label: "−", cls: "op" },
  { k: "1" }, { k: "2" }, { k: "3" }, { k: "+", cls: "op" },
  { k: "0", cls: "wide" }, { k: "." }, { k: "=", cls: "eq" },
];

export function Calculator({ locale, t, onToPaid }: { locale: Locale; t: Messages; onToPaid: (value: number) => void }) {
  const [s, setS] = useState(initialCalc);
  const text = calcDisplay(s);
  const shown = (() => {
    const [w, f] = text.split(".");
    const whole = formatNumber(locale, Number(w ?? "0"));
    return f === undefined ? whole : `${whole}${locale === "en" ? "." : "٫"}${locale === "en" ? f : [...f].map((c) => formatNumber(locale, Number(c))).join("")}`;
  })();
  const digit = (k: string) => (/^\d$/.test(k) ? formatNumber(locale, Number(k)) : k === "." ? (locale === "en" ? "." : "٫") : null);
  return (
    <section className="ot-card ot-calc-card" aria-label={t.till.one.calculator} data-testid="calculator">
      <div className="ot-body">
        <output className="ot-calc-out" dir="ltr" data-testid="calc-out">{shown}</output>
        <div className="ot-calc" dir="ltr">
          {KEYS.map((key) => (
            <button key={key.k} type="button" className={key.cls} onClick={() => setS((c) => calcPress(c, key.k))} data-testid={`calc-${key.k}`}>
              {key.label ?? digit(key.k) ?? key.k}
            </button>
          ))}
        </div>
        <button type="button" className="ot-tojoin" onClick={() => onToPaid(parseFloat(text) || 0)} data-testid="calc-to-paid">
          {t.till.one.calcToPaid}
        </button>
      </div>
    </section>
  );
}
