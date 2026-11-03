import type { ReactNode } from "react";
import { formatDateTime, formatNumber, type Locale, type Messages } from "@/messages";
import { fill, formatMoney, pickName } from "../../../_lib/format";
import { CardIcon, CashIcon, MinusIcon, PlusIcon, TrashIcon } from "../../../_ui/icons";
import { lineTotal, type CartLine, type Currency, type PayState, type ReceiptDto, type SellItemDto, type ShiftDto } from "./cart";

/*
 * The till's views, pure (no state, no effects): the client screen wires them, and the UI tests
 * render them to markup. Every text comes from t; money is formatted in the interface's digits.
 * Names are never split per character (Arabic letters must stay joined).
 */

type Ctx = { locale: Locale; t: Messages };

export const money = (ctx: Ctx, currency: Currency, minor: bigint | string) =>
  formatMoney(ctx.locale, currency, minor, ctx.t.catalog.currencyShort[currency]);

/** A quantity typed in ASCII ("0.25") in the interface's digits. */
export function localQuantity(locale: Locale, q: string): string {
  if (locale === "en") return q;
  return [...q].map((c) => (c === "." ? "٫" : /\d/.test(c) ? formatNumber(locale, Number(c)) : c)).join("");
}

/** One big product tile. Without a price it is shown but disabled. */
export function Tile({ locale, t, item, onAdd }: Ctx & { item: SellItemDto; onAdd?: () => void }) {
  const name = pickName(locale, item);
  const priced = item.priceMinor !== null;
  const out = item.onHand !== null && BigInt(item.onHand) <= 0n;
  return (
    <button
      type="button"
      className="till-tile"
      onClick={onAdd}
      disabled={!priced}
      data-out={out || undefined}
      data-testid="sell-tile"
    >
      <span className="till-tile-name">{name}</span>
      <span className="till-tile-foot">
        <span className="till-tile-price">{priced ? money({ locale, t }, item.currency, item.priceMinor!) : t.sell.noPrice}</span>
        <span className="till-tile-unit">{out ? t.sell.outOfStock : item.unitName}</span>
      </span>
    </button>
  );
}

/** One cart line: name, price x qty, total, and big - / + (a weighed line gets a weight box instead). */
export function CartLineRow({
  locale,
  t,
  line,
  currency,
  onStep,
  onRemove,
  weightBox,
}: Ctx & { line: CartLine; currency: Currency; onStep?: (d: 1 | -1) => void; onRemove?: () => void; weightBox?: ReactNode }) {
  const name = pickName(locale, line);
  const weighed = line.quantityScale > 0;
  return (
    <li className="till-line" data-testid="cart-line">
      <div className="till-line-main">
        <span className="till-line-name">{name}</span>
        <span className="till-line-meta">
          {money({ locale, t }, currency, line.priceMinor)} / {line.unitName}
        </span>
      </div>
      <strong className="till-line-total">{money({ locale, t }, currency, lineTotal(line))}</strong>
      <div className="till-line-controls">
        {weighed ? (
          weightBox
        ) : (
          <div className="till-stepper">
            <button type="button" className="till-step" onClick={() => onStep?.(-1)} aria-label={fill(t.sell.decrease, { name })} data-testid="cart-dec">
              <MinusIcon />
            </button>
            <output className="till-qty" aria-live="polite" data-testid="cart-qty">
              {localQuantity(locale, line.quantity)}
            </output>
            <button type="button" className="till-step" onClick={() => onStep?.(1)} aria-label={fill(t.sell.increase, { name })} data-testid="cart-inc">
              <PlusIcon />
            </button>
          </div>
        )}
        <button type="button" className="till-remove" onClick={onRemove} aria-label={fill(t.sell.remove, { name })} data-testid="cart-remove">
          <TrashIcon />
        </button>
      </div>
    </li>
  );
}

/** The amount rows of the pay screen: due, received, remaining or change. */
export function PaySummary({ locale, t, currency, state }: Ctx & { currency: Currency; state: PayState }) {
  const m = (v: bigint) => money({ locale, t }, currency, v);
  return (
    <dl className="till-pay-summary" data-testid="pay-summary">
      <div className="till-pay-due">
        <dt>{t.sell.payScreen.due}</dt>
        <dd data-testid="pay-due">{m(state.due)}</dd>
      </div>
      <div>
        <dt>{t.sell.payScreen.given}</dt>
        <dd data-testid="pay-given">{m(state.paid)}</dd>
      </div>
      {state.remaining > 0n ? (
        <div data-tone="warn">
          <dt>{t.sell.payScreen.remaining}</dt>
          <dd data-testid="pay-remaining">{m(state.remaining)}</dd>
        </div>
      ) : (
        <div data-tone="good">
          <dt>{t.sell.payScreen.change}</dt>
          <dd data-testid="pay-change">{m(state.change)}</dd>
        </div>
      )}
    </dl>
  );
}

/** The printed and shown receipt. */
export function Receipt({ locale, t, receipt, business, branch, cashier }: Ctx & { receipt: ReceiptDto; business: string; branch: string; cashier: string }) {
  const m = (v: string) => money({ locale, t }, receipt.currency, v);
  const cash = receipt.payments.find((p) => p.method === "CASH");
  const card = receipt.payments.find((p) => p.method === "CARD");
  return (
    <article className="till-receipt" data-testid="receipt">
      <header className="till-receipt-head">
        <strong>{business}</strong>
        <span>{branch}</span>
        <span>{fill(t.sell.receipt.number, { n: formatNumber(locale, receipt.number) })}</span>
        <span>{formatDateTime(locale, new Date(receipt.postedAt))}</span>
        <span>{cashier}</span>
      </header>
      <ul className="till-receipt-lines">
        {receipt.lines.map((l) => (
          <li key={l.lineNo}>
            <span className="till-receipt-name">{pickName(locale, l)}</span>
            <span className="till-receipt-qty">
              {localQuantity(locale, l.quantity)} {l.unitName} × {m(l.unitPriceMinor)}
            </span>
            <span className="till-receipt-amount">{m(l.lineTotalMinor)}</span>
          </li>
        ))}
      </ul>
      <dl className="till-receipt-totals">
        <div className="till-receipt-total">
          <dt>{t.sell.total}</dt>
          <dd data-testid="receipt-total">{m(receipt.totalMinor)}</dd>
        </div>
        {cash ? (
          <>
            <div>
              <dt>{t.sell.receipt.given}</dt>
              <dd>{m(cash.tenderedMinor)}</dd>
            </div>
            <div>
              <dt>{t.sell.receipt.cash}</dt>
              <dd>{m(cash.amountMinor)}</dd>
            </div>
          </>
        ) : null}
        {card ? (
          <div>
            <dt>{t.sell.receipt.card}</dt>
            <dd>{m(card.amountMinor)}</dd>
          </div>
        ) : null}
        {BigInt(receipt.changeMinor) > 0n ? (
          <div>
            <dt>{t.sell.receipt.change}</dt>
            <dd data-testid="receipt-change">{m(receipt.changeMinor)}</dd>
          </div>
        ) : null}
      </dl>
      <p className="till-receipt-thanks">{t.sell.receipt.thanks}</p>
    </article>
  );
}

/** The shift's day summary: sales count, total, cash, card, opening and expected cash. */
export function ShiftSummaryView({ locale, t, shift }: Ctx & { shift: ShiftDto }) {
  const m = (v: string) => money({ locale, t }, shift.currency, v);
  return (
    <section className="till-summary" aria-labelledby="shift-summary-title" data-testid="shift-summary">
      <h2 id="shift-summary-title">{t.sell.close.summary}</h2>
      <p className="muted">{fill(t.sell.close.openedAt, { at: formatDateTime(locale, new Date(shift.openedAt)) })}</p>
      <dl className="till-summary-grid">
        <div>
          <dt>{t.sell.close.salesCount}</dt>
          <dd data-testid="summary-count">{formatNumber(locale, shift.salesCount)}</dd>
        </div>
        <div>
          <dt>{t.sell.close.totalSales}</dt>
          <dd data-testid="summary-total">{m(shift.totalMinor)}</dd>
        </div>
        <div>
          <dt>
            <CashIcon /> {t.sell.close.cashSales}
          </dt>
          <dd data-testid="summary-cash">{m(shift.cashMinor)}</dd>
        </div>
        <div>
          <dt>
            <CardIcon /> {t.sell.close.cardSales}
          </dt>
          <dd data-testid="summary-card">{m(shift.cardMinor)}</dd>
        </div>
        <div>
          <dt>{t.sell.close.opening}</dt>
          <dd>{m(shift.openingCashMinor)}</dd>
        </div>
        <div className="till-summary-expected">
          <dt>{t.sell.close.expected}</dt>
          <dd data-testid="summary-expected">{m(shift.expectedCashMinor)}</dd>
        </div>
      </dl>
    </section>
  );
}

/** counted - expected, worded: over, short, or matches. */
export function differenceText(ctx: Ctx, currency: Currency, diff: bigint): { tone: "good" | "warn" | "bad"; text: string } {
  if (diff === 0n) return { tone: "good", text: ctx.t.sell.close.matches };
  if (diff > 0n) return { tone: "warn", text: `${ctx.t.sell.close.over} ${money(ctx, currency, diff)}` };
  return { tone: "bad", text: `${ctx.t.sell.close.short} ${money(ctx, currency, -diff)}` };
}
