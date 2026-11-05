import type { CSSProperties } from "react";
import { formatDateTime, formatNumber, type Locale, type Messages } from "@/messages";
import { fill, formatMoney, pickName } from "../../../_lib/format";
import { BackspaceIcon, CardIcon, CashIcon, MinusIcon, PlusIcon, TrashIcon } from "../../../_ui/icons";
import { lineTotal, type CartLine, type Currency, type PayState, type ReceiptDto, type SellItemDto, type ShiftDto } from "./cart";
import { CatIcon } from "./cat-icons";
import { numpadKeys, tileInitials, type CategoryIconKind, type NumpadKey } from "./till";

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

/**
 * One product tile, a card: a block in its category's colour with the category's picture and the
 * name's first letters (the slot a photo takes once the catalog has them), then the name on up to
 * two lines and the price, large. `qty` is how many are in the cart now. An item without a price is
 * shown but cannot be added.
 */
export function Tile({
  locale,
  t,
  item,
  tone = null,
  kind = null,
  qty = 0,
  onAdd,
}: Ctx & { item: SellItemDto; tone?: number | null; kind?: CategoryIconKind | null; qty?: number; onAdd?: () => void }) {
  const name = pickName(locale, item);
  const letters = tileInitials(name);
  const priced = item.priceMinor !== null;
  const priceText = priced ? money({ locale, t }, item.currency, item.priceMinor!) : t.sell.noPrice;
  const out = item.onHand !== null && BigInt(item.onHand) <= 0n;
  return (
    <button
      type="button"
      className="till-tile"
      onClick={onAdd}
      disabled={!priced}
      data-out={out || undefined}
      data-tone={tone ?? undefined}
      data-incart={qty > 0 || undefined}
      data-testid="sell-tile"
    >
      <span className="till-tile-media">
        {kind ? <CatIcon kind={kind} className="till-tile-art" /> : null}
        <span className="till-tile-initial" dir="auto" aria-hidden="true">
          {letters.length === 1 ? letters[0] : letters.map((l, i) => <span key={i}>{l}</span>)}
        </span>
        {out ? <span className="till-tile-flag">{t.sell.outOfStock}</span> : null}
        {qty > 0 ? (
          <span className="till-tile-qty" aria-hidden="true" data-testid="tile-qty" key={qty}>
            {localQuantity(locale, String(qty))}
          </span>
        ) : null}
      </span>
      <span className="till-tile-name">{name}</span>
      <span className="till-tile-price" style={{ "--len": [...priceText].length } as CSSProperties}>
        {priceText}
      </span>
    </button>
  );
}

/** One cart line: name and unit price, the quantity (tap: numpad), big - / + for pieces, the line total. */
export function CartLineRow({
  locale,
  t,
  line,
  currency,
  onStep,
  onRemove,
  onEditQty,
  last = false,
}: Ctx & { line: CartLine; currency: Currency; onStep?: (d: 1 | -1) => void; onRemove?: () => void; onEditQty?: () => void; last?: boolean }) {
  const name = pickName(locale, line);
  const weighed = line.quantityScale > 0;
  const qty = (
    <button type="button" className="till-qty" onClick={onEditQty} aria-label={fill(t.till.editQty, { name })} data-testid="cart-qty">
      {localQuantity(locale, line.quantity)}
      {weighed ? <span className="till-qty-unit">{line.unitName}</span> : null}
    </button>
  );
  return (
    <li className="till-line" data-last={last || undefined} data-testid="cart-line">
      <div className="till-line-main">
        <span className="till-line-name">{name}</span>
        <span className="till-line-meta">
          {money({ locale, t }, currency, line.priceMinor)} / {line.unitName}
        </span>
      </div>
      <strong className="till-line-total">{money({ locale, t }, currency, lineTotal(line))}</strong>
      <div className="till-line-controls">
        {weighed ? (
          qty
        ) : (
          <div className="till-stepper">
            <button type="button" className="till-step" onClick={() => onStep?.(-1)} aria-label={fill(t.sell.decrease, { name })} data-testid="cart-dec">
              <MinusIcon />
            </button>
            {qty}
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

/**
 * The big numpad: digits laid out like a calculator (7 8 9 on top, in every language: it is a
 * device layout, not reading order), "000" for dinar or "." where decimals are allowed, and
 * backspace. Digits show in the interface's numerals.
 */
export function Numpad({ locale, t, label, decimals, onPress, disabled = false }: Ctx & { label: string; decimals: number; onPress: (key: NumpadKey) => void; disabled?: boolean }) {
  return (
    <div className="till-numpad" dir="ltr" role="group" aria-label={label} data-testid="numpad">
      {numpadKeys(decimals).map((k) => (
        <button
          key={k}
          type="button"
          className="till-key"
          data-key={k}
          onClick={() => onPress(k)}
          disabled={disabled}
          aria-label={k === "back" ? t.till.backspace : undefined}
          data-testid={`key-${k === "." ? "dot" : k}`}
        >
          {k === "back" ? <BackspaceIcon /> : k === "." ? DECIMAL[locale] : localDigitsOf(locale, k)}
        </button>
      ))}
    </div>
  );
}

const DECIMAL: Record<Locale, string> = { ar: "٫", ckb: "٫", en: "." };
const localDigitsOf = (locale: Locale, digits: string) => (locale === "en" ? digits : [...digits].map((d) => formatNumber(locale, Number(d))).join(""));

/** Numpad text ("12500.5") in the interface's digits with thousands grouped, for the big display above the keys. */
export function entryText(locale: Locale, text: string): string {
  if (text === "") return "";
  const [whole = "", frac] = text.split(".");
  const grouped = whole === "" ? "" : formatNumber(locale, BigInt(whole));
  return frac === undefined ? grouped : `${grouped}${DECIMAL[locale]}${localDigitsOf(locale, frac)}`;
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
          <div>
            <dt>{t.sell.receipt.cash}</dt>
            <dd>{m(cash.amountMinor)}</dd>
          </div>
        ) : null}
        {cash && cash.tenderedMinor !== cash.amountMinor ? (
          <div>
            <dt>{t.sell.receipt.given}</dt>
            <dd>{m(cash.tenderedMinor)}</dd>
          </div>
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
