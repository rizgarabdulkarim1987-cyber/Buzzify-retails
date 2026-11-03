"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { formatDateTime, formatNumber, type Locale, type Messages } from "@/messages";
import { fill, pickName } from "../../_lib/format";
import { CardIcon, CartIcon, CashIcon, PauseIcon, PrintIcon, SearchIcon } from "../../_ui/icons";
import { Notice } from "../../_ui/state";
import { failureMessage } from "../catalog/_lib/failures";
import { newKey } from "../catalog/_lib/keys";
import { createSaleAction, pricesAction, sellItemsAction } from "./actions";
import {
  addCash,
  addItem,
  cardRest,
  cartCount,
  cartTotal,
  exactCash,
  holdCart,
  normalizeQuantity,
  parseAmount,
  parseHeld,
  payState,
  paymentsOf,
  quickAmounts,
  removeLine,
  repriceLines,
  resumeCart,
  setQuantity,
  stepLine,
  type CartLine,
  type CategoryDto,
  type Currency,
  type HeldCart,
  type ReceiptDto,
  type SellItemDto,
  type ShiftDto,
  type Tender,
} from "./_lib/cart";
import { CartLineRow, PaySummary, Receipt, Tile, localQuantity, money } from "./_lib/views";

type Props = {
  locale: Locale;
  t: Messages;
  currency: Currency;
  shift: ShiftDto;
  locationId: string;
  categories: CategoryDto[];
  initialItems: SellItemDto[];
  /** localStorage key of this device's held carts (per business and user). */
  heldKey: string;
  business: string;
  branch: string;
  cashier: string;
};

type Mode = "sell" | "pay" | "receipt";
const NO_TENDER: Tender = { cashMinor: 0n, cardMinor: 0n };

/*
 * Held carts live in this device's localStorage, read through useSyncExternalStore (no flash of a
 * wrong list on hydration). When storage is blocked (a private window) they live in memory until
 * the page is left.
 */
const HELD_EVENT = "till-held-change";
const memoryHeld = new Map<string, string>();

function readHeldRaw(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return memoryHeld.get(key) ?? null;
  }
}
function writeHeld(key: string, held: HeldCart[]) {
  const raw = JSON.stringify(held);
  try {
    window.localStorage.setItem(key, raw);
  } catch {
    memoryHeld.set(key, raw);
  }
  window.dispatchEvent(new Event(HELD_EVENT));
}
function subscribeHeld(onChange: () => void) {
  window.addEventListener("storage", onChange);
  window.addEventListener(HELD_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(HELD_EVENT, onChange);
  };
}

const isTyping = (el: EventTarget | null) =>
  el instanceof HTMLElement && (el.isContentEditable || el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT");

/**
 * The till: categories and tiles on one side, the cart with a big total and PAY on the other (a
 * bottom bar and a sheet on a phone), then the pay screen and the receipt. A scanner types into the
 * search box and ends with Enter: a single barcode hit goes straight into the cart.
 */
export function SellScreen({ locale, t, currency, shift, locationId, categories, initialItems, heldKey, business, branch, cashier }: Props) {
  const ctx = { locale, t };
  const s = t.sell;
  const [category, setCategory] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<SellItemDto[]>(initialItems);
  const [loading, setLoading] = useState(false);
  const [lines, setLines] = useState<CartLine[]>([]);
  const heldRaw = useSyncExternalStore(
    subscribeHeld,
    () => readHeldRaw(heldKey),
    () => null,
  );
  const held = useMemo(() => parseHeld(heldRaw), [heldRaw]);
  const [showHeld, setShowHeld] = useState(false);
  const [mode, setMode] = useState<Mode>("sell");
  const [cartOpen, setCartOpen] = useState(false);
  const [tender, setTender] = useState<Tender>(NO_TENDER);
  const [other, setOther] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [announce, setAnnounce] = useState("");
  const [receipt, setReceipt] = useState<ReceiptDto | null>(null);
  const [weights, setWeights] = useState<Record<string, string>>({});
  const searchRef = useRef<HTMLInputElement>(null);
  const payRef = useRef<HTMLDivElement>(null);
  /** The current attempt's key: kept across a network retry, dropped when the cart or the payment changes. */
  const keyRef = useRef<string | null>(null);
  const searchSeq = useRef(0);

  const total = useMemo(() => cartTotal(lines), [lines]);
  const count = useMemo(() => cartCount(lines), [lines]);
  const pay = payState(total, tender);

  useEffect(() => {
    keyRef.current = null;
  }, [lines, tender]);

  const load = useCallback(
    async (q: string, cat: string | null): Promise<SellItemDto[] | null> => {
      const seq = ++searchSeq.current;
      setLoading(true);
      try {
        const r = await sellItemsAction({ query: q, categoryId: cat, locationId });
        if (seq !== searchSeq.current) return null;
        if (!r.ok) {
          setError(failureMessage(t, r));
          return null;
        }
        setItems(r.value);
        return r.value;
      } catch {
        if (seq === searchSeq.current) setError(s.failures.network);
        return null;
      } finally {
        if (seq === searchSeq.current) setLoading(false);
      }
    },
    [locationId, t, s.failures.network],
  );

  // Typed text searches after a short pause; Enter (a scanner) searches at once.
  useEffect(() => {
    if (query.trim() === "") return;
    const id = window.setTimeout(() => void load(query, null), 300);
    return () => window.clearTimeout(id);
  }, [query, load]);

  // Any printable key typed outside a field goes to the search box (a scanner works without a tap first).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (mode !== "sell" || e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1 || isTyping(e.target)) return;
      searchRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode]);

  const add = (item: SellItemDto) => {
    if (item.priceMinor === null) return;
    setError(null);
    setNotice(null);
    setLines((ls) => addItem(ls, item));
    setAnnounce(fill(s.added, { name: pickName(locale, item) }));
  };

  const pickCategory = (id: string | null) => {
    setCategory(id);
    setQuery("");
    void load("", id);
  };

  const onSearch = async (e: FormEvent) => {
    e.preventDefault();
    const q = query.trim();
    if (q === "") return;
    const found = await load(q, null);
    if (found && found.length === 1 && found[0]!.matchedBarcode) {
      add(found[0]!);
      setQuery("");
      void load("", category);
    }
  };

  const clearSearch = () => {
    setQuery("");
    void load("", category);
    searchRef.current?.focus();
  };

  const commitWeight = (line: CartLine) => {
    const text = weights[line.key];
    if (text === undefined) return;
    const next = setQuantity(lines, line.key, text);
    if (!next) {
      setError(s.failures.badQuantity);
      return;
    }
    setError(null);
    setLines(next);
    setWeights((w) => Object.fromEntries(Object.entries(w).filter(([k]) => k !== line.key)));
  };

  const hold = () => {
    if (lines.length === 0) return;
    writeHeld(heldKey, holdCart(held, lines, newKey(), new Date()));
    setLines([]);
    setCartOpen(false);
  };

  const resume = (id: string) => {
    const r = resumeCart(held, id);
    if (!r) return;
    // The current cart, if any, is held in its place so nothing is lost.
    writeHeld(heldKey, lines.length > 0 ? holdCart(r.held, lines, newKey(), new Date()) : r.held);
    setLines(r.lines);
    setShowHeld(false);
  };

  const openPay = () => {
    if (lines.length === 0) return;
    setError(null);
    setTender(NO_TENDER);
    setOther("");
    setMode("pay");
    setCartOpen(false);
  };

  useEffect(() => {
    if (mode === "pay") payRef.current?.querySelector<HTMLButtonElement>("button[data-first]")?.focus();
    if (mode === "sell") searchRef.current?.focus({ preventScroll: true });
  }, [mode]);

  useEffect(() => {
    if (mode !== "pay") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !sending) setMode("sell");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, sending]);

  const addOther = (e: FormEvent) => {
    e.preventDefault();
    const v = parseAmount(other, currency);
    if (v === null || v === 0n) {
      setError(s.failures.badAmount);
      return;
    }
    setError(null);
    setTender((tn) => addCash(tn, v));
    setOther("");
  };

  const confirm = async () => {
    if (!pay.ready || sending) return;
    keyRef.current ??= newKey();
    const key = keyRef.current;
    setSending(true);
    setError(null);
    try {
      const r = await createSaleAction(key, {
        lines: lines.map((l) => ({ variantId: l.variantId, unitId: l.unitId, quantity: l.quantity })),
        payments: paymentsOf(tender),
        expectedTotalMinor: total.toString(),
      });
      if (r.ok) {
        setReceipt(r.value);
        setLines([]);
        setTender(NO_TENDER);
        setMode("receipt");
        return;
      }
      if (r.code === "PRICE_CHANGED") {
        const p = await pricesAction([...new Set(lines.map((l) => l.unitId))]);
        if (p.ok) setLines((ls) => repriceLines(ls, p.value));
        setMode("sell");
        setNotice(s.failures.priceChanged);
        return;
      }
      if (r.code === "PAYMENT_RULE" && r.details?.reason === "CASH_NOT_NEEDED") {
        setError(s.payScreen.cashNotNeeded);
        return;
      }
      setError(failureMessage(t, r));
    } catch {
      // The request may or may not have reached the server: the same key makes a retry safe.
      setError(s.failures.network);
    } finally {
      setSending(false);
    }
  };

  const newSale = () => {
    setReceipt(null);
    setMode("sell");
    setNotice(null);
    setError(null);
  };

  const m = (v: bigint | string) => money(ctx, currency, v);

  if (mode === "receipt" && receipt) {
    return (
      <div className="till-done" data-testid="sell-receipt">
        <div className="till-done-head">
          <h1>{s.receipt.title}</h1>
          {BigInt(receipt.changeMinor) > 0n ? (
            <p className="till-done-change">
              {s.receipt.change}: <strong data-testid="done-change">{m(receipt.changeMinor)}</strong>
            </p>
          ) : null}
        </div>
        <Receipt locale={locale} t={t} receipt={receipt} business={business} branch={branch} cashier={cashier} />
        <div className="till-done-actions">
          <button type="button" className="btn btn-secondary till-big" onClick={() => window.print()} data-testid="receipt-print">
            <PrintIcon />
            {s.receipt.print}
          </button>
          <button type="button" className="btn btn-primary till-big" onClick={newSale} autoFocus data-testid="receipt-new">
            {s.receipt.newSale}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="till" data-cart-open={cartOpen || undefined}>
      <p className="visually-hidden" role="status" aria-live="polite">
        {announce}
      </p>

      <section className="till-catalog" aria-label={s.items}>
        <div className="till-strip">
          <span className="till-shift">{fill(s.shiftSince, { at: formatDateTime(locale, new Date(shift.openedAt)) })}</span>
          <Link href="/retail/sell/close" className="till-strip-link" data-testid="open-close-shift">
            {s.close.link}
          </Link>
        </div>

        <form className="till-search" role="search" onSubmit={onSearch}>
          <label className="visually-hidden" htmlFor="till-search">
            {s.search}
          </label>
          <SearchIcon />
          <input
            ref={searchRef}
            id="till-search"
            className="till-search-input"
            type="search"
            enterKeyHint="search"
            autoComplete="off"
            placeholder={s.search}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            data-testid="sell-search"
          />
          {query !== "" ? (
            <button type="button" className="till-search-clear" onClick={clearSearch}>
              {s.clearSearch}
            </button>
          ) : null}
        </form>

        {categories.length > 0 ? (
          <nav className="till-cats" aria-label={s.categories}>
            <button type="button" className="till-cat" aria-pressed={category === null} onClick={() => pickCategory(null)} data-testid="sell-cat-all">
              {s.all}
            </button>
            {categories.map((c) => (
              <button key={c.id} type="button" className="till-cat" aria-pressed={category === c.id} onClick={() => pickCategory(c.id)} data-testid="sell-cat">
                {pickName(locale, c)}
              </button>
            ))}
          </nav>
        ) : null}

        {notice ? <Notice tone="success">{notice}</Notice> : null}
        {error && mode === "sell" ? <Notice tone="danger">{error}</Notice> : null}

        <div className="till-tiles" aria-busy={loading} data-testid="sell-tiles">
          {items.length === 0 && !loading ? (
            <p className="till-empty">{query.trim() !== "" ? fill(s.noMatch, { q: query.trim() }) : s.noItemsTitle}</p>
          ) : (
            items.map((it) => <Tile key={`${it.variantId}:${it.unitId}`} locale={locale} t={t} item={it} onAdd={() => add(it)} />)
          )}
        </div>
      </section>

      <aside className="till-cart" aria-label={s.cart} data-testid="sell-cart">
        <div className="till-cart-head">
          <h2>
            {s.cart}
            {count > 0 ? <span className="till-count">{formatNumber(locale, count)}</span> : null}
          </h2>
          <div className="till-cart-tools">
            {held.length > 0 ? (
              <button type="button" className="btn btn-secondary" onClick={() => setShowHeld((v) => !v)} aria-expanded={showHeld} data-testid="held-toggle">
                {s.held} {formatNumber(locale, held.length)}
              </button>
            ) : null}
            <button type="button" className="btn btn-secondary" onClick={hold} disabled={lines.length === 0} data-testid="cart-hold">
              <PauseIcon />
              {s.hold}
            </button>
            <button type="button" className="btn btn-secondary till-sheet-close" onClick={() => setCartOpen(false)}>
              {s.items}
            </button>
          </div>
        </div>

        {showHeld ? (
          <ul className="till-held" aria-label={s.heldTitle} data-testid="held-list">
            {held.map((h) => (
              <li key={h.id}>
                <span>{fill(s.heldLine, { n: formatNumber(locale, h.lines.length), at: formatDateTime(locale, new Date(h.at)) })}</span>
                <button type="button" className="btn btn-secondary" onClick={() => resume(h.id)} data-testid="held-resume">
                  {s.resume}
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        {lines.length === 0 ? (
          <div className="till-cart-empty" data-testid="cart-empty">
            <CartIcon />
            <strong>{s.cartEmptyTitle}</strong>
            <span>{s.cartEmptyBody}</span>
          </div>
        ) : (
          <ul className="till-lines">
            {lines.map((l) => (
              <CartLineRow
                key={l.key}
                locale={locale}
                t={t}
                line={l}
                currency={currency}
                onStep={(d) => setLines((ls) => stepLine(ls, l.key, d))}
                onRemove={() => setLines((ls) => removeLine(ls, l.key))}
                weightBox={
                  <label className="till-weight">
                    <span className="visually-hidden">{fill(s.weight, { unit: l.unitName })}</span>
                    <input
                      className="input"
                      inputMode="decimal"
                      value={weights[l.key] ?? localQuantity(locale, l.quantity)}
                      onChange={(e) => setWeights((w) => ({ ...w, [l.key]: e.target.value }))}
                      onBlur={() => commitWeight(l)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitWeight(l);
                      }}
                      onFocus={(e) => e.currentTarget.select()}
                      aria-invalid={weights[l.key] !== undefined && normalizeQuantity(weights[l.key]!, l.quantityScale) === null}
                      data-testid="cart-weight"
                    />
                    <span aria-hidden="true">{l.unitName}</span>
                  </label>
                }
              />
            ))}
          </ul>
        )}

        <div className="till-cart-foot">
          <div className="till-total">
            <span>{s.total}</span>
            <strong data-testid="cart-total">{m(total)}</strong>
          </div>
          <button type="button" className="btn btn-primary till-pay" onClick={openPay} disabled={lines.length === 0} data-testid="cart-pay">
            {s.pay}
          </button>
          {lines.length > 0 ? (
            <button type="button" className="till-clear" onClick={() => setLines([])} data-testid="cart-clear">
              {s.clear}
            </button>
          ) : null}
        </div>
      </aside>

      {/* Phone: the bar that is always in reach of the thumb. */}
      <div className="till-bar">
        <button type="button" className="till-bar-cart" onClick={() => setCartOpen(true)} aria-label={s.viewCart} data-testid="bar-cart">
          <CartIcon />
          <span className="till-count">{formatNumber(locale, count)}</span>
          <strong>{m(total)}</strong>
        </button>
        <button type="button" className="btn btn-primary till-pay" onClick={openPay} disabled={lines.length === 0} data-testid="bar-pay">
          {s.pay}
        </button>
      </div>

      {mode === "pay" ? (
        <div className="till-pay-layer" role="dialog" aria-modal="true" aria-labelledby="pay-title" data-testid="pay-panel">
          <div className="till-pay-panel" ref={payRef}>
            <div className="till-pay-head">
              <h2 id="pay-title">{s.payScreen.title}</h2>
              <button type="button" className="btn btn-secondary" onClick={() => setMode("sell")} disabled={sending}>
                {s.payScreen.back}
              </button>
            </div>
            <PaySummary locale={locale} t={t} currency={currency} state={pay} />

            <h3 className="till-pay-label">
              <CashIcon /> {s.payScreen.cash}
            </h3>
            <div className="till-notes">
              {quickAmounts(total, currency).map((v, i) => (
                <button
                  key={v.toString()}
                  type="button"
                  className="till-note"
                  data-first={i === 0 || undefined}
                  onClick={() => setTender((tn) => (i === 0 && v === total ? exactCash(total, tn) : addCash(tn, v)))}
                  disabled={sending}
                  data-testid="pay-note"
                >
                  {i === 0 && v === total ? <span className="till-note-tag">{s.payScreen.exact}</span> : null}
                  {m(v)}
                </button>
              ))}
            </div>
            <form className="till-other" onSubmit={addOther}>
              <label className="visually-hidden" htmlFor="pay-other">
                {s.payScreen.other}
              </label>
              <input
                id="pay-other"
                className="input"
                inputMode={currency === "IQD" ? "numeric" : "decimal"}
                placeholder={s.payScreen.other}
                value={other}
                onChange={(e) => setOther(e.target.value)}
                autoComplete="off"
                data-testid="pay-other"
              />
              <button type="submit" className="btn btn-secondary" disabled={sending}>
                {s.payScreen.add}
              </button>
            </form>

            <h3 className="till-pay-label">
              <CardIcon /> {s.payScreen.card}
            </h3>
            <div className="till-card-row">
              <button type="button" className="till-note till-card" onClick={() => setTender((tn) => cardRest(total, tn))} disabled={sending || pay.remaining === 0n} data-testid="pay-card">
                {tender.cashMinor > 0n ? s.payScreen.cardRest : s.payScreen.cardAll}
              </button>
              {tender.cardMinor > 0n ? <span className="till-card-amount">{fill(s.payScreen.cardPart, { amount: m(tender.cardMinor) })}</span> : null}
            </div>

            {error ? <Notice tone="danger">{error}</Notice> : null}

            <div className="till-pay-foot">
              <button type="button" className="till-clear" onClick={() => setTender(NO_TENDER)} disabled={sending || pay.paid === 0n} data-testid="pay-reset">
                {s.payScreen.reset}
              </button>
              <button type="button" className="btn btn-primary till-pay" onClick={confirm} disabled={!pay.ready || sending} aria-busy={sending} data-testid="pay-confirm">
                {sending ? s.payScreen.sending : s.payScreen.confirm}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
