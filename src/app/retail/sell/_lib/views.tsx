import type { CSSProperties } from "react";
import { formatDateTime, formatNumber, formatTime, type Locale, type Messages } from "@/messages";
import { fill, formatMoney, pickName } from "../../../_lib/format";
import { BackspaceIcon, CardIcon, CashIcon, DollarIcon, MinusIcon, PlusIcon } from "../../../_ui/icons";
import { lineTotal, type CartLine, type Currency, type PayState, type ReceiptDto, type SellItemDto, type ShiftDto } from "./cart";
import type { ExpenseDto } from "./expenses";
import { numpadKeys, type NumpadKey } from "./till";

/*
 * The till's views, pure (no state, no effects): the client screen wires them, and the UI tests
 * render them to markup. Every text comes from t; money is formatted in the interface's digits.
 * Names are never split per character (Arabic letters must stay joined).
 */

type Ctx = { locale: Locale; t: Messages };

export const money = (ctx: Ctx, currency: Currency, minor: bigint | string) =>
  formatMoney(ctx.locale, currency, minor, ctx.t.catalog.currencyShort[currency]);

/** "1 $ = 1,450 د.ع": the shift's dollar rate in the interface's digits. */
export function rateLine(ctx: Ctx, rateMicro: bigint | string): string {
  const rate = formatNumber(ctx.locale, Number(BigInt(rateMicro)) / 1_000_000);
  return fill(ctx.t.till.rateLine, { rate });
}

/** A quantity typed in ASCII ("0.25") in the interface's digits. */
export function localQuantity(locale: Locale, q: string): string {
  if (locale === "en") return q;
  return [...q].map((c) => (c === "." ? "٫" : /\d/.test(c) ? formatNumber(locale, Number(c)) : c)).join("");
}

/**
 * One product tile, text first: the name on up to two lines, the price, and a thin bar in its
 * No colour and no picture area (the catalog has no photos). `qty` is how many are
 * in the cart now. An item without a price is shown but cannot be added.
 */
export function Tile({ locale, t, item, qty = 0, onAdd }: Ctx & { item: SellItemDto; qty?: number; onAdd?: () => void }) {
  const name = pickName(locale, item);
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
      data-incart={qty > 0 || undefined}
      data-testid="sell-tile"
    >
      <span className="till-tile-name">{name}</span>
      <span className="till-tile-price" style={{ "--len": [...priceText].length } as CSSProperties}>
        {priceText}
      </span>
      {out ? <span className="till-tile-flag">{t.sell.outOfStock}</span> : null}
      {qty > 0 ? (
        <span className="till-tile-qty" aria-hidden="true" data-testid="tile-qty" key={qty}>
          {localQuantity(locale, String(qty))}
        </span>
      ) : null}
    </button>
  );
}

/**
 * One ticket line, receipt style: the name (two lines at most), the quantity, the unit price and
 * the line total in four columns. The whole row is one button that selects it; the numpad then edits it.
 */
export function TicketRow({
  locale,
  t,
  line,
  currency,
  selected = false,
  last = false,
  onSelect,
}: Ctx & { line: CartLine; currency: Currency; selected?: boolean; last?: boolean; onSelect?: () => void }) {
  const name = pickName(locale, line);
  const weighed = line.quantityScale > 0;
  const price = money({ locale, t }, currency, line.priceMinor);
  return (
    <li className="till-row" data-selected={selected || undefined} data-last={last || undefined} data-testid="cart-line">
      <button type="button" className="till-row-btn" aria-pressed={selected} onClick={onSelect} aria-label={fill(t.till.editQty, { name })} data-testid="cart-select">
        <span className="till-row-name">
          {name}
          <small className="till-row-sub">
            {price} / {line.unitName}
          </small>
        </span>
        <span className="till-row-qty" data-testid="cart-qty">
          {localQuantity(locale, line.quantity)}
          {weighed ? <small>{line.unitName}</small> : null}
        </span>
        <span className="till-row-price">{price}</span>
        <strong className="till-row-total">{money({ locale, t }, currency, lineTotal(line))}</strong>
      </button>
    </li>
  );
}

/**
 * The ticket's permanent keypad. It edits the selected line's quantity: digits (and the decimal mark
 * for a weighed item) type the new quantity, backspace deletes a digit, C starts the entry over,
 * + and - add or take one. Qty is the only mode: the app has no price override or discount, so
 * no dead keys are shown. Layout is a device layout (7 8 9 on top), the same in every language.
 */
export function TicketPad({
  locale,
  t,
  decimals,
  name,
  disabled = false,
  onPress,
  onStep,
}: Ctx & { decimals: number; name: string; disabled?: boolean; onPress: (key: NumpadKey) => void; onStep: (d: 1 | -1) => void }) {
  const digit = (k: string) => (
    <button key={k} type="button" className="till-key" data-key={k} onClick={() => onPress(k as NumpadKey)} disabled={disabled} data-testid={`key-${k}`}>
      {localDigitsOf(locale, k)}
    </button>
  );
  return (
    <div className="till-pad" dir="ltr" role="group" aria-label={t.till.qtyTitle} data-testid="ticket-pad">
      {["7", "8", "9"].map(digit)}
      <button type="button" className="till-key till-key-mode" aria-pressed="true" onClick={() => onPress("clear")} disabled={disabled} data-testid="key-mode-qty">
        {t.till.colQty}
      </button>
      {["4", "5", "6"].map(digit)}
      <button type="button" className="till-key till-key-op" data-op="plus" onClick={() => onStep(1)} disabled={disabled} aria-label={fill(t.sell.increase, { name })} data-testid="key-plus">
        <PlusIcon />
      </button>
      {["1", "2", "3"].map(digit)}
      <button type="button" className="till-key till-key-op" data-op="minus" onClick={() => onStep(-1)} disabled={disabled} aria-label={fill(t.sell.decrease, { name })} data-testid="key-minus">
        <MinusIcon />
      </button>
      {decimals > 0 ? (
        <button type="button" className="till-key" data-key="." onClick={() => onPress(".")} disabled={disabled} data-testid="key-dot">
          {DECIMAL[locale]}
        </button>
      ) : null}
      <button type="button" className="till-key" data-key="0" data-wide={decimals === 0 || undefined} onClick={() => onPress("0")} disabled={disabled} data-testid="key-0">
        {localDigitsOf(locale, "0")}
      </button>
      <button type="button" className="till-key" data-key="back" onClick={() => onPress("back")} disabled={disabled} aria-label={t.till.backspace} data-testid="key-back">
        <BackspaceIcon />
      </button>
      <button type="button" className="till-key till-key-op" data-op="clear" onClick={() => onPress("clear")} disabled={disabled} aria-label={t.till.clearEntry} data-testid="key-clear">
        C
      </button>
    </div>
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

/**
 * The payment methods: Cash IQD | Cash USD | Card. Without a shift rate the dollars are not offered and
 * the row is exactly the old one (Cash, Card). `target` is the cash the keypad types.
 */
export function PayMethods({
  locale,
  t,
  target,
  usd,
  cardLabel,
  cardDisabled,
  disabled,
  onTarget,
  onCard,
}: Ctx & {
  target: "IQD" | "USD";
  usd: boolean;
  cardLabel: string;
  cardDisabled: boolean;
  disabled: boolean;
  onTarget: (target: "IQD" | "USD") => void;
  onCard: () => void;
}) {
  void locale;
  return (
    <div className="till-methods" role="group" aria-label={t.till.methods} data-count={usd ? 3 : 2}>
      {usd ? (
        <button type="button" className="till-method" aria-pressed={target === "IQD"} onClick={() => onTarget("IQD")} disabled={disabled} data-testid="pay-method-iqd">
          <CashIcon />
          {t.till.cashIqd}
        </button>
      ) : (
        <span className="till-method" aria-current="true" data-testid="pay-method-iqd">
          <CashIcon />
          {t.till.payCash}
        </span>
      )}
      {usd ? (
        <button type="button" className="till-method" aria-pressed={target === "USD"} onClick={() => onTarget("USD")} disabled={disabled} data-testid="pay-method-usd">
          <DollarIcon />
          {t.till.cashUsd}
        </button>
      ) : null}
      <button type="button" className="till-method" onClick={onCard} disabled={disabled || cardDisabled} data-testid="pay-card">
        <CardIcon />
        {cardLabel}
      </button>
    </div>
  );
}

/** What is still due in dollars (rounded up to the cent that covers it) and the rate it is worked out at. */
export function UsdDue({ locale, t, dueCents, rateMicro }: Ctx & { dueCents: bigint; rateMicro: string }) {
  const ctx = { locale, t };
  return (
    <p className="till-usd-due" data-testid="pay-usd-due">
      <span>{t.till.dueInDollars}</span>
      <strong>{money(ctx, "USD", dueCents)}</strong>
      <small data-testid="pay-rate">{rateLine(ctx, rateMicro)}</small>
    </p>
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
  const cash = receipt.payments.find((p) => p.method === "CASH" && !p.usdMinor);
  const usd = receipt.payments.find((p) => p.method === "CASH" && p.usdMinor);
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
        {usd ? (
          <>
            <div data-testid="receipt-usd">
              <dt>{t.till.dollarsReceived}</dt>
              <dd>{money({ locale, t }, "USD", usd.usdMinor!)}</dd>
            </div>
            <div>
              <dt>{t.till.rate}</dt>
              <dd>{rateLine({ locale, t }, usd.rateMicro ?? "0")}</dd>
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
            <dt>{usd ? t.till.changeDinars : t.sell.receipt.change}</dt>
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
        {BigInt(shift.expensesMinor) > 0n ? (
          <div>
            <dt>{t.expense.expenses}</dt>
            <dd data-testid="summary-expenses">{m(shift.expensesMinor)}</dd>
          </div>
        ) : null}
        <div className="till-summary-expected">
          <dt>{t.sell.close.expected}</dt>
          <dd data-testid="summary-expected">{m(shift.expectedCashMinor)}</dd>
        </div>
        {shift.usdRateMicro !== null ? (
          <>
            <div>
              <dt>{t.till.rate}</dt>
              <dd>{rateLine({ locale, t }, shift.usdRateMicro)}</dd>
            </div>
            <div>
              <dt>
                <DollarIcon /> {t.till.dollarsReceived}
              </dt>
              <dd data-testid="summary-usd">{money({ locale, t }, "USD", shift.usdTenderedMinor)}</dd>
            </div>
            <div>
              <dt>{t.till.openingDollars}</dt>
              <dd>{money({ locale, t }, "USD", shift.openingUsdMinor)}</dd>
            </div>
            <div className="till-summary-expected">
              <dt>{t.till.dollarsInDrawer}</dt>
              <dd data-testid="summary-expected-usd">{money({ locale, t }, "USD", shift.expectedUsdMinor ?? "0")}</dd>
            </div>
          </>
        ) : null}
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

export type VoidDraft = { id: string; reason: string };

/**
 * The shift's expenses, newest first: time, category, note, amount. A voided one stays, struck through,
 * with its reason. `who` is the person who rang the shift (only they record on it). With `onVoid` (managers
 * and owners, an open shift) each live row has a Void button that opens a reason field under the row.
 */
export function ExpenseList({
  locale,
  t,
  currency,
  list,
  who,
  draft = null,
  busy = false,
  error = null,
  onVoid,
  onDraft,
  onConfirm,
  onCancel,
}: Ctx & {
  currency: Currency;
  list: readonly ExpenseDto[];
  who: string;
  draft?: VoidDraft | null;
  busy?: boolean;
  error?: string | null;
  onVoid?: (id: string) => void;
  onDraft?: (reason: string) => void;
  onConfirm?: () => void;
  onCancel?: () => void;
}) {
  const x = t.expense;
  const m = (v: string) => money({ locale, t }, currency, v);
  if (list.length === 0) {
    return (
      <p className="till-x-empty" data-testid="expense-empty">
        {x.listEmpty}
      </p>
    );
  }
  return (
    <ul className="till-x-list" data-testid="expense-list">
      {list.map((e) => {
        const voided = e.voidedAt !== null;
        return (
          <li key={e.id} className="till-x-row" data-voided={voided || undefined} data-testid="expense-row">
            <div className="till-x-main">
              <strong>{x.categories[e.categoryKey]}</strong>
              <b className="till-x-amount" data-testid="expense-amount">
                {m(e.amountMinor)}
              </b>
              {e.note ? <span className="till-x-note">{e.note}</span> : null}
              <small className="till-x-meta">
                {formatTime(locale, new Date(e.createdAt))}
                {who ? ` · ${fill(x.by, { name: who })}` : ""}
              </small>
            </div>
            {voided ? (
              <p className="till-x-void" data-testid="expense-voided">
                <span className="till-x-badge">{x.voided}</span> {e.voidReason ? fill(x.voidedReason, { reason: e.voidReason }) : null}
              </p>
            ) : onVoid && draft?.id !== e.id ? (
              <button type="button" className="till-x-voidbtn" onClick={() => onVoid(e.id)} disabled={busy} aria-label={`${x.voidTitle}: ${x.categories[e.categoryKey]} ${m(e.amountMinor)}`} data-testid="expense-void">
                {x.void}
              </button>
            ) : null}
            {draft?.id === e.id ? (
              <div className="till-x-voidform" data-testid="expense-void-form">
                <label className="visually-hidden" htmlFor="expense-void-reason">
                  {x.voidReason}
                </label>
                <input
                  id="expense-void-reason"
                  className="input"
                  type="text"
                  maxLength={500}
                  placeholder={x.voidReason}
                  value={draft.reason}
                  onChange={(ev) => onDraft?.(ev.target.value)}
                  disabled={busy}
                  autoFocus
                  data-testid="expense-void-reason"
                />
                {error ? (
                  <p className="till-x-error" role="alert">
                    {error}
                  </p>
                ) : null}
                <div className="till-x-voidacts">
                  <button type="button" className="till-btn till-btn-quiet" onClick={onCancel} disabled={busy}>
                    {x.cancel}
                  </button>
                  <button type="button" className="till-btn till-btn-danger" onClick={onConfirm} disabled={busy || draft.reason.trim() === ""} aria-busy={busy} data-testid="expense-void-confirm">
                    {x.voidConfirm}
                  </button>
                </div>
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
