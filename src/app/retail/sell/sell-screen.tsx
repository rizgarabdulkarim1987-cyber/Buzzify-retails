"use client";

import Link from "next/link";
import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type FormEvent } from "react";
import { formatDateTime, formatNumber, type Locale, type Messages } from "@/messages";
import { fill, pickName } from "../../_lib/format";
import { CardIcon, CartIcon, CashIcon, CloseIcon, DrawerIcon, GridIcon, MenuIcon, PauseIcon, PrintIcon, SearchIcon, SignOutIcon, TrashIcon } from "../../_ui/icons";
import { LocaleSwitcher } from "../../_ui/locale-switcher";
import { Notice } from "../../_ui/state";
import { signOut } from "../../session-actions";
import { failureMessage } from "../catalog/_lib/failures";
import { newKey } from "../catalog/_lib/keys";
import { createSaleAction, pricesAction, sellItemsAction } from "./actions";
import {
  addItem,
  cardRest,
  cartCount,
  cartTotal,
  holdCart,
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
} from "./_lib/cart";
import { categoryTone, keyFromKeyboard, minorToEntry, moneyDecimals, numpadPress, textLength, type NumpadKey } from "./_lib/till";
import { CartLineRow, Numpad, Receipt, Tile, entryText, localQuantity, money } from "./_lib/views";
import { TillNav } from "./till-nav";
import { DotsIcon } from "./_lib/nav-icons";

type Props = {
  locale: Locale;
  t: Messages;
  currency: Currency;
  shift: ShiftDto;
  locationId: string;
  categories: CategoryDto[];
  initialItems: SellItemDto[];
  /** Items per page of the read model: a full page means there may be more. */
  pageSize: number;
  /** localStorage key of this device's held carts (per business and user). */
  heldKey: string;
  business: string;
  branch: string;
  operator: string;
};

type Mode = "sell" | "pay" | "receipt";

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

const subscribeOnline = (onChange: () => void) => {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
};

type BoardTileProps = { locale: Locale; t: Messages; item: SellItemDto; tone: number | null; qty: number; onAdd: (item: SellItemDto) => void };

/** A tile that re-renders only when its own item, colour or cart quantity changes (hundreds of them stay quick). */
const BoardTile = memo(function BoardTile({ locale, t, item, tone, qty, onAdd }: BoardTileProps) {
  return <Tile locale={locale} t={t} item={item} tone={tone} qty={qty} onAdd={() => onAdd(item)} />;
});

const SKELETON_TILES = Array.from({ length: 12 }, (_, i) => i);

/** The size of a very large amount: the box width divided by the text length, set as --len. */
const lenStyle = (text: string) => ({ "--len": textLength(text) }) as CSSProperties;

const isTyping = (el: EventTarget | null) =>
  el instanceof HTMLElement && (el.isContentEditable || el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT");

/** A mouse or a scanner-equipped desk: focusing the search box does not pop a touch keyboard. */
const finePointer = () => typeof window !== "undefined" && window.matchMedia("(pointer: fine)").matches;

/**
 * The touch till. Wide screens: category tiles, the product grid and the cart side by side (the
 * grid flows with the page direction, so in Arabic and Sorani the categories sit on the right and
 * the cart on the left). Phones: the grid full width and a bottom bar (count, total, Pay) that
 * opens the cart as a sheet. A barcode scanner types into the search box and ends with Enter: a
 * single barcode hit goes straight into the cart. The numpad edits quantities and takes the cash.
 */
export function SellScreen({ locale, t, currency, shift, locationId, categories, initialItems, pageSize, heldKey, business, branch, operator }: Props) {
  const ctx = { locale, t };
  const s = t.sell;
  const tl = t.till;
  const [category, setCategory] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  /** The browsed page(s) of the chosen category; a search shows `results` instead. */
  const [browse, setBrowse] = useState<{ items: SellItemDto[]; more: boolean }>({ items: initialItems, more: initialItems.length >= pageSize });
  const [results, setResults] = useState<SellItemDto[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [lines, setLines] = useState<CartLine[]>([]);
  const [lastKey, setLastKey] = useState<string | null>(null);
  const heldRaw = useSyncExternalStore(subscribeHeld, () => readHeldRaw(heldKey), () => null);
  const held = useMemo(() => parseHeld(heldRaw), [heldRaw]);
  const [mode, setMode] = useState<Mode>("sell");
  const [cartOpen, setCartOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [qtyFor, setQtyFor] = useState<string | null>(null);
  const [qtyText, setQtyText] = useState("");
  const [cashText, setCashText] = useState("");
  const [cardMinor, setCardMinor] = useState(0n);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [announce, setAnnounce] = useState("");
  const [switching, setSwitching] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  const online = useSyncExternalStore(subscribeOnline, () => navigator.onLine, () => true);
  const [receipt, setReceipt] = useState<ReceiptDto | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const linesRef = useRef<HTMLUListElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  /** The current attempt's key: kept across a network retry, dropped when the cart or the payment changes. */
  const keyRef = useRef<string | null>(null);
  const searchSeq = useRef(0);

  const total = useMemo(() => cartTotal(lines), [lines]);
  const count = useMemo(() => cartCount(lines), [lines]);
  const cashMinor = parseAmount(cashText.replace(/\.$/, "") || "0", currency) ?? 0n;
  const tender = { cashMinor, cardMinor };
  const pay = payState(total, tender);
  const toneOf = useCallback((id: string | null) => categoryTone(categories, id), [categories]);
  const qtyLine = qtyFor ? (lines.find((l) => l.key === qtyFor) ?? null) : null;
  const m = (v: bigint | string) => money(ctx, currency, v);
  const inCart = useMemo(() => {
    const q = new Map<string, number>();
    for (const l of lines) {
      const k = `${l.variantId}:${l.unitId}`;
      q.set(k, (q.get(k) ?? 0) + Number(l.quantity));
    }
    return q;
  }, [lines]);

  useEffect(() => {
    keyRef.current = null;
  }, [lines, cashText, cardMinor]);

  const fetchItems = useCallback(
    async (q: string, cat: string | null, offset = 0): Promise<SellItemDto[] | null> => {
      const seq = ++searchSeq.current;
      setLoading(true);
      try {
        const r = await sellItemsAction({ query: q, categoryId: cat, locationId, offset });
        if (seq !== searchSeq.current) return null;
        if (!r.ok) {
          setError(failureMessage(t, r));
          return null;
        }
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
    const id = window.setTimeout(async () => {
      const found = await fetchItems(query, null);
      if (found) setResults(found);
    }, 300);
    return () => window.clearTimeout(id);
  }, [query, fetchItems]);

  const overlay = mode !== "sell" || menuOpen || qtyFor !== null;

  // Any printable key typed outside a field goes to the search box: a scanner works without a tap first.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (overlay || e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1 || isTyping(e.target)) return;
      searchRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [overlay]);

  // Back on the sale screen: the search box is ready for the scanner (not on touch, where it would pop the keyboard).
  useEffect(() => {
    if (!overlay && finePointer()) searchRef.current?.focus({ preventScroll: true });
  }, [overlay]);

  // The line just touched stays in view in the cart.
  useEffect(() => {
    linesRef.current?.querySelector("[data-last]")?.scrollIntoView({ block: "nearest" });
  }, [lastKey, lines]);

  const add = useCallback(
    (item: SellItemDto) => {
      if (item.priceMinor === null) return;
      setError(null);
      setNotice(null);
      setLines((ls) => addItem(ls, item));
      setLastKey(`${item.variantId}:${item.unitId}`);
      setAnnounce(fill(s.added, { name: pickName(locale, item) }));
    },
    [locale, s.added],
  );

  const pickCategory = async (id: string | null) => {
    setCategory(id);
    setQuery("");
    setResults(null);
    setSwitching(true);
    const found = await fetchItems("", id);
    setSwitching(false);
    if (found) setBrowse({ items: found, more: found.length >= pageSize });
  };

  const loadMore = async () => {
    const found = await fetchItems("", category, browse.items.length);
    if (found) setBrowse((b) => ({ items: [...b.items, ...found], more: found.length >= pageSize }));
  };

  const onSearch = async (e: FormEvent) => {
    e.preventDefault();
    const q = query.trim();
    if (q === "") return;
    const found = await fetchItems(q, null);
    if (!found) return;
    if (found.length === 1 && found[0]!.matchedBarcode) {
      add(found[0]!);
      setQuery("");
      setResults(null);
      return;
    }
    setResults(found);
  };

  const clearSearch = () => {
    setQuery("");
    setResults(null);
    searchSeq.current++;
    setLoading(false);
    searchRef.current?.focus();
  };

  // Menu ---------------------------------------------------------------------------------------

  const hold = () => {
    setMoreOpen(false);
    if (lines.length === 0) return;
    writeHeld(heldKey, holdCart(held, lines, newKey(), new Date()));
    setLines([]);
    setMenuOpen(false);
  };

  const resume = (id: string) => {
    const r = resumeCart(held, id);
    if (!r) return;
    // The current cart, if any, is held in its place so nothing is lost.
    writeHeld(heldKey, lines.length > 0 ? holdCart(r.held, lines, newKey(), new Date()) : r.held);
    setLines(r.lines);
    setMenuOpen(false);
  };

  const clearCart = () => {
    setMoreOpen(false);
    setLines([]);
    setMenuOpen(false);
  };

  // The cart's one small actions menu closes on Escape or a tap anywhere else.
  useEffect(() => {
    if (!moreOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMoreOpen(false);
    };
    const onDown = (e: PointerEvent) => {
      if (!moreRef.current?.contains(e.target as Node)) setMoreOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown);
    };
  }, [moreOpen]);

  useEffect(() => {
    if (!menuOpen) return;
    menuRef.current?.querySelector<HTMLElement>("button:not(:disabled), a")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  // Quantity numpad -----------------------------------------------------------------------------

  const openQty = (key: string) => {
    setQtyFor(key);
    setQtyText("");
    setError(null);
  };

  const commitQty = useCallback(() => {
    if (!qtyLine) return setQtyFor(null);
    if (qtyText === "") return setQtyFor(null);
    if (/^0*\.?0*$/.test(qtyText)) {
      setLines((ls) => removeLine(ls, qtyLine.key));
      return setQtyFor(null);
    }
    const next = setQuantity(lines, qtyLine.key, qtyText);
    if (!next) return setError(s.failures.badQuantity);
    setError(null);
    setLines(next);
    setLastKey(qtyLine.key);
    setQtyFor(null);
  }, [qtyLine, qtyText, lines, s.failures.badQuantity]);

  useEffect(() => {
    if (!qtyLine) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") return setQtyFor(null);
      if (e.key === "Enter") {
        e.preventDefault();
        return commitQty();
      }
      const k = keyFromKeyboard(e.key);
      if (k) {
        e.preventDefault();
        setQtyText((x) => numpadPress(x, k, qtyLine.quantityScale));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [qtyLine, commitQty]);

  // Paying ---------------------------------------------------------------------------------------

  const openPay = () => {
    if (lines.length === 0) return;
    setError(null);
    setCashText("");
    setCardMinor(0n);
    setMode("pay");
    setCartOpen(false);
  };

  const pressCash = (k: NumpadKey) => setCashText((x) => numpadPress(x, k, moneyDecimals(currency)));
  const setCash = (v: bigint) => setCashText(minorToEntry(currency, v));
  const exact = () => setCash(total > cardMinor ? total - cardMinor : 0n);
  const byCard = () => {
    const r = cardRest(total, tender);
    setCardMinor(r.cardMinor);
    setCash(r.cashMinor);
  };
  const resetPay = () => {
    setCashText("");
    setCardMinor(0n);
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
        resetPay();
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

  const confirmRef = useRef(confirm);
  useEffect(() => {
    confirmRef.current = confirm;
  });
  useEffect(() => {
    if (mode !== "pay") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !sending) return setMode("sell");
      if (sending || isTyping(e.target)) return;
      if (e.key === "Enter") {
        e.preventDefault();
        return void confirmRef.current();
      }
      const k = keyFromKeyboard(e.key);
      if (k) {
        e.preventDefault();
        setCashText((x) => numpadPress(x, k, moneyDecimals(currency)));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, sending, currency]);

  const newSale = () => {
    setReceipt(null);
    setMode("sell");
    setNotice(null);
    setError(null);
  };

  // Receipt ----------------------------------------------------------------------------------------

  if (mode === "receipt" && receipt) {
    const change = BigInt(receipt.changeMinor);
    return (
      <div className="till-done" data-testid="sell-receipt">
        <div className="till-done-head">
          <h1>{s.receipt.title}</h1>
          <p className="till-done-total">{m(receipt.totalMinor)}</p>
          {change > 0n ? (
            <p className="till-done-change">
              <span>{tl.changeDue}</span>
              <strong data-testid="done-change">{m(change)}</strong>
            </p>
          ) : null}
        </div>
        <div className="till-done-actions">
          <button type="button" className="till-btn till-btn-go till-btn-xl" onClick={newSale} autoFocus data-testid="receipt-new">
            {s.receipt.newSale}
          </button>
          <button type="button" className="till-btn till-btn-quiet" onClick={() => window.print()} data-testid="receipt-print">
            <PrintIcon />
            {s.receipt.print}
          </button>
        </div>
        <Receipt locale={locale} t={t} receipt={receipt} business={business} branch={branch} cashier={operator} />
      </div>
    );
  }

  const shown = query.trim() !== "" && results !== null ? results : browse.items;
  const searching = query.trim() !== "";
  const totalText = m(total);

  const cartBody =
    lines.length === 0 ? (
      <div className="till-cart-empty" data-testid="cart-empty">
        <CartIcon />
        <strong>{s.cartEmptyTitle}</strong>
        <span>{s.cartEmptyBody}</span>
      </div>
    ) : (
      <ul className="till-lines" ref={linesRef}>
        {lines.map((l) => (
          <CartLineRow
            key={l.key}
            locale={locale}
            t={t}
            line={l}
            currency={currency}
            last={l.key === lastKey}
            onStep={(d) => {
              setLines((ls) => stepLine(ls, l.key, d));
              setLastKey(l.key);
            }}
            onRemove={() => setLines((ls) => removeLine(ls, l.key))}
            onEditQty={() => openQty(l.key)}
          />
        ))}
      </ul>
    );

  return (
    <div className="till-app" data-cart-open={cartOpen || undefined} data-testid="till">
      <p className="visually-hidden" role="status" aria-live="polite">
        {announce}
      </p>

      <TillNav t={t} variant="rail" />

      <header className="till-top">
        <div className="till-top-id">
          <strong className="truncate" title={business}>
            {business}
          </strong>
          <span className="truncate" title={`${branch} · ${operator}`}>
            {branch} · {tl.operator}: {operator}
          </span>
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
            spellCheck={false}
            placeholder={s.search}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              if (e.target.value.trim() === "") setResults(null);
            }}
            data-testid="sell-search"
          />
          {query !== "" ? (
            <button type="button" className="till-search-clear" onClick={clearSearch} aria-label={s.clearSearch}>
              <CloseIcon />
            </button>
          ) : null}
        </form>
        <button type="button" className="till-menu-btn" onClick={() => setMenuOpen(true)} aria-haspopup="dialog" aria-expanded={menuOpen} data-testid="till-menu">
          <MenuIcon />
          <span className="till-menu-label">{tl.menu}</span>
          {held.length > 0 ? <span className="till-badge">{formatNumber(locale, held.length)}</span> : null}
        </button>
      </header>

      <nav className="till-cats" aria-label={s.categories}>
        <button type="button" className="till-cat" data-tone="all" aria-pressed={category === null && !searching} onClick={() => void pickCategory(null)} data-testid="sell-cat-all">
          <span>{s.all}</span>
        </button>
        {categories.map((c) => (
          <button
            key={c.id}
            type="button"
            className="till-cat"
            data-tone={toneOf(c.id) ?? undefined}
            aria-pressed={category === c.id && !searching}
            onClick={() => void pickCategory(c.id)}
            data-testid="sell-cat"
          >
            <i className="till-dot" aria-hidden="true" />
            <span>{pickName(locale, c)}</span>
          </button>
        ))}
      </nav>

      <section className="till-products" aria-label={s.items} aria-busy={loading}>
        {!online ? (
          <p className="till-offline" role="status" data-testid="till-offline">
            {tl.offline}
          </p>
        ) : null}
        {notice ? <Notice tone="success">{notice}</Notice> : null}
        {error && mode === "sell" && qtyFor === null ? <Notice tone="danger">{error}</Notice> : null}
        {switching ? (
          <div className="till-tiles" data-testid="sell-skeleton" aria-hidden="true">
            {SKELETON_TILES.map((i) => (
              <span key={i} className="till-tile-skel" />
            ))}
          </div>
        ) : shown.length === 0 && !loading ? (
          <div className="till-empty">
            <strong>{searching ? fill(s.noMatch, { q: query.trim() }) : s.noItemsTitle}</strong>
            {searching ? null : <span>{s.noItemsBody}</span>}
          </div>
        ) : (
          <div className="till-tiles" data-testid="sell-tiles">
            {shown.map((it) => {
              const k = `${it.variantId}:${it.unitId}`;
              return (
                <BoardTile
                  key={k}
                  locale={locale}
                  t={t}
                  item={it}
                  tone={toneOf(it.categoryId)}
                  qty={inCart.get(k) ?? 0}
                  onAdd={add}
                />
              );
            })}
          </div>
        )}
        {!searching && browse.more ? (
          <button type="button" className="till-btn till-btn-quiet till-more" onClick={() => void loadMore()} disabled={loading} data-testid="sell-more">
            {tl.showMore}
          </button>
        ) : null}
      </section>

      <div className="till-sheet-scrim" onClick={() => setCartOpen(false)} aria-hidden="true" />
      <aside className="till-cart" aria-label={s.cart} data-testid="sell-cart">
        <div className="till-cart-head">
          <h2>
            {s.cart}
            {count > 0 ? <span className="till-count">{formatNumber(locale, count)}</span> : null}
          </h2>
          <div className="till-more-wrap" ref={moreRef}>
            <button type="button" className="till-icon-btn till-more-btn" onClick={() => setMoreOpen((v) => !v)} aria-haspopup="menu" aria-expanded={moreOpen} aria-label={tl.cartActions} data-testid="cart-more">
              <DotsIcon />
            </button>
            {moreOpen ? (
              <div className="till-popover" role="menu" data-testid="cart-more-menu">
                <button type="button" role="menuitem" className="till-pop-item" onClick={hold} disabled={lines.length === 0} data-testid="cart-hold-quick">
                  <PauseIcon />
                  {tl.holdCart}
                </button>
                <button type="button" role="menuitem" className="till-pop-item till-pop-danger" onClick={clearCart} disabled={lines.length === 0} data-testid="cart-clear-quick">
                  <TrashIcon />
                  {tl.clearCart}
                </button>
              </div>
            ) : null}
          </div>
          <button type="button" className="till-icon-btn till-sheet-close" onClick={() => setCartOpen(false)} aria-label={s.items}>
            <CloseIcon />
          </button>
        </div>
        {cartBody}
        <div className="till-cart-foot">
          <div className="till-total">
            <span>
              {s.total}
              <small>{fill(tl.itemCount, { n: formatNumber(locale, count) })}</small>
            </span>
            <strong data-testid="cart-total" style={lenStyle(totalText)}>
              {totalText}
            </strong>
          </div>
          <button type="button" className="till-btn till-btn-go till-pay" onClick={openPay} disabled={lines.length === 0} data-testid="cart-pay">
            {s.pay}
          </button>
        </div>
      </aside>

      {/* Phone: the bar that is always in reach of the thumb. */}
      <div className="till-bar">
        <button type="button" className="till-bar-cart" onClick={() => setCartOpen(true)} aria-label={s.viewCart} data-testid="bar-cart">
          <span className="till-count">{formatNumber(locale, count)}</span>
          <strong>{totalText}</strong>
        </button>
        <button type="button" className="till-btn till-btn-go till-bar-pay" onClick={openPay} disabled={lines.length === 0} data-testid="bar-pay">
          {s.pay}
        </button>
      </div>

      {menuOpen ? (
        <div className="till-layer" onClick={(e) => e.target === e.currentTarget && setMenuOpen(false)}>
          <div className="till-menu" role="dialog" aria-modal="true" aria-labelledby="till-menu-title" ref={menuRef} data-testid="menu-panel">
            <div className="till-menu-head">
              <h2 id="till-menu-title">{tl.menu}</h2>
              <button type="button" className="till-icon-btn" onClick={() => setMenuOpen(false)} aria-label={tl.closeMenu}>
                <CloseIcon />
              </button>
            </div>
            <TillNav t={t} variant="list" onNavigate={() => setMenuOpen(false)} />
            <p className="till-menu-shift">{fill(s.shiftSince, { at: formatDateTime(locale, new Date(shift.openedAt)) })}</p>
            <div className="till-menu-actions">
              <button type="button" className="till-menu-item" onClick={hold} disabled={lines.length === 0} data-testid="cart-hold">
                <PauseIcon />
                {tl.holdCart}
              </button>
              <button type="button" className="till-menu-item" onClick={clearCart} disabled={lines.length === 0} data-testid="cart-clear">
                <TrashIcon />
                {tl.clearCart}
              </button>
              <Link href="/retail/sell/close" className="till-menu-item" data-testid="open-close-shift">
                <DrawerIcon />
                {tl.closeShift}
              </Link>
            </div>
            {held.length > 0 ? (
              <section className="till-held" aria-label={s.heldTitle} data-testid="held-list">
                <h3>{fill(tl.heldCarts, { n: formatNumber(locale, held.length) })}</h3>
                <ul>
                  {held.map((h) => (
                    <li key={h.id}>
                      <span>{fill(s.heldLine, { n: formatNumber(locale, h.lines.length), at: formatDateTime(locale, new Date(h.at)) })}</span>
                      <button type="button" className="till-btn till-btn-quiet" onClick={() => resume(h.id)} data-testid="held-resume">
                        {s.resume}
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            <div className="till-menu-foot">
              <Link href="/retail/home?menu=1" className="till-menu-link" data-testid="open-shop-menu">
                <GridIcon />
                {tl.shopMenu}
              </Link>
              <LocaleSwitcher key={locale} locale={locale} label={tl.language} names={{ ar: t.locale.ar, ckb: t.locale.ckb, en: t.locale.en }} tone="light" />
              <form action={signOut}>
                <button type="submit" className="till-menu-link">
                  <SignOutIcon />
                  {t.common.signOut}
                </button>
              </form>
            </div>
          </div>
        </div>
      ) : null}

      {qtyLine ? (
        <div className="till-layer" onClick={(e) => e.target === e.currentTarget && setQtyFor(null)}>
          <div className="till-qtypad" role="dialog" aria-modal="true" aria-labelledby="qty-title" data-testid="qty-panel">
            <h2 id="qty-title" className="truncate">
              {pickName(locale, qtyLine)}
            </h2>
            <p className="till-qtypad-hint">
              {qtyLine.quantityScale > 0 ? fill(tl.qtyWeight, { unit: qtyLine.unitName }) : tl.qtyPieces} · {tl.qtyZero}
            </p>
            <output className="till-display" aria-live="polite" data-testid="qty-display" data-placeholder={qtyText === "" || undefined}>
              {qtyText === "" ? localQuantity(locale, qtyLine.quantity) : entryText(locale, qtyText)}
            </output>
            {error ? <Notice tone="danger">{error}</Notice> : null}
            {qtyLine.quantityScale === 0 ? (
              <div className="till-quickqty" dir="ltr" role="group" aria-label={tl.quickQty}>
                {[1, 2, 3, 5, 10, 12].map((n) => (
                  <button key={n} type="button" className="till-chip" onClick={() => setQtyText(String(n))}>
                    {formatNumber(locale, n)}
                  </button>
                ))}
              </div>
            ) : null}
            <Numpad locale={locale} t={t} label={tl.qtyTitle} decimals={qtyLine.quantityScale} onPress={(k) => setQtyText((x) => numpadPress(x, k, qtyLine.quantityScale))} />
            <div className="till-pad-actions">
              <button type="button" className="till-btn till-btn-quiet" onClick={() => setQtyFor(null)}>
                {tl.cancel}
              </button>
              <button type="button" className="till-btn till-btn-go" onClick={commitQty} data-testid="qty-ok">
                {tl.ok}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {mode === "pay" ? (
        <div className="till-layer till-layer-full">
          <div className="till-paypad" role="dialog" aria-modal="true" aria-labelledby="pay-title" data-testid="pay-panel">
            <div className="till-pay-head">
              <h2 id="pay-title">{s.payScreen.title}</h2>
              <button type="button" className="till-btn till-btn-quiet" onClick={() => setMode("sell")} disabled={sending}>
                {s.payScreen.back}
              </button>
            </div>
            <div className="till-pay-body">
              <dl className="till-pay-summary" data-testid="pay-summary">
                <div className="till-pay-due">
                  <dt>{s.payScreen.due}</dt>
                  <dd data-testid="pay-due" style={lenStyle(totalText)}>
                    {totalText}
                  </dd>
                </div>
                <div className="till-pay-given">
                  <dt>
                    <CashIcon /> {tl.cashReceived}
                  </dt>
                  <dd className="till-display" data-testid="pay-given" data-placeholder={cashText === "" || undefined}>
                    {cashText === "" ? m(0n) : `${entryText(locale, cashText)} ${t.catalog.currencyShort[currency]}`}
                  </dd>
                </div>
                {cardMinor > 0n ? (
                  <div>
                    <dt>
                      <CardIcon /> {tl.cardAmount}
                    </dt>
                    <dd data-testid="pay-card-amount">{m(cardMinor)}</dd>
                  </div>
                ) : null}
                {pay.remaining > 0n ? (
                  <div className="till-pay-result" data-tone="warn">
                    <dt>{tl.stillDue}</dt>
                    <dd data-testid="pay-remaining">{m(pay.remaining)}</dd>
                  </div>
                ) : (
                  <div className="till-pay-result" data-tone="good">
                    <dt>{tl.changeDue}</dt>
                    <dd data-testid="pay-change">{m(pay.change)}</dd>
                  </div>
                )}
              </dl>
              <div className="till-pay-keys">
                <div className="till-notes">
                  {quickAmounts(total > cardMinor ? total - cardMinor : 0n, currency).map((v, i) => (
                    <button key={v.toString()} type="button" className="till-note" onClick={() => (i === 0 ? exact() : setCash(v))} disabled={sending} style={lenStyle(m(v))} data-testid="pay-note">
                      {i === 0 ? <span className="till-note-tag">{tl.exact}</span> : null}
                      <span className="till-note-amount">{m(v)}</span>
                    </button>
                  ))}
                </div>
                <Numpad locale={locale} t={t} label={tl.cashReceived} decimals={moneyDecimals(currency)} onPress={pressCash} disabled={sending} />
                <div className="till-pay-row">
                  <button type="button" className="till-btn till-btn-quiet" onClick={resetPay} disabled={sending || (cashText === "" && cardMinor === 0n)} data-testid="pay-reset">
                    {tl.clearEntry}
                  </button>
                  <button type="button" className="till-btn till-btn-quiet" onClick={byCard} disabled={sending || pay.remaining === 0n} data-testid="pay-card">
                    <CardIcon />
                    {cashMinor > 0n ? s.payScreen.cardRest : s.payScreen.cardAll}
                  </button>
                </div>
              </div>
            </div>
            {!online ? (
              <p className="till-offline" role="status">
                {tl.offline}
              </p>
            ) : null}
            {error ? <Notice tone="danger">{error}</Notice> : null}
            <button type="button" className="till-btn till-btn-go till-pay till-pay-confirm" onClick={() => void confirm()} disabled={!pay.ready || sending} aria-busy={sending} data-testid="pay-confirm">
              {sending ? s.payScreen.sending : s.payScreen.confirm}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
