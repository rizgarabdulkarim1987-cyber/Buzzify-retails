"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type FormEvent } from "react";
import { formatDateTime, formatNumber, type Locale, type Messages } from "@/messages";
import { dinarToUsdCentsCeil, usdToDinar } from "@/server/domain/fx";
import { fill, pickName } from "../../_lib/format";
import { CardIcon, CashIcon, CloseIcon, DollarIcon, DrawerIcon, GridIcon, PrintIcon, SignOutIcon, TrashIcon } from "../../_ui/icons";
import { LocaleSwitcher } from "../../_ui/locale-switcher";
import { Notice } from "../../_ui/state";
import { signOut } from "../../session-actions";
import { failureMessage } from "../catalog/_lib/failures";
import { newKey } from "../catalog/_lib/keys";
import { createSaleAction, pricesAction, recentSalesAction, sellItemsAction } from "./actions";
import {
  addItem,
  lineKey,
  cardRest,
  cartCount,
  cartTotal,
  lineTotal,
  parseAmount,
  parseHeld,
  payState,
  paymentsOf,
  quickAmounts,
  quickUsdAmounts,
  removeLine,
  repriceLines,
  setQuantity,
  stepLine,
  type CartLine,
  type Currency,
  type HeldCart,
  type ReceiptDto,
  type SellItemDto,
  type ShiftDto,
} from "./_lib/cart";
import { MAX_TICKETS, closeTicket, latestTicket, openTicket, orderTickets, saveTicket, ticketLines, ticketTotals, touchTicket } from "./_lib/tickets";
import { keyFromKeyboard, minorToEntry, moneyDecimals, numpadPress, type NumpadKey } from "./_lib/till";
import { Numpad, PayMethods, Receipt, UsdDue, entryText, localQuantity, money, rateLine } from "./_lib/views";
import { ExpensePanel } from "./expense-panel";
import { LineTable } from "./line-table";
import { Calculator, ProductCard, ReceiptsCard, ShiftCard } from "./side-column";
import { TillNav } from "./till-nav";

type Props = {
  locale: Locale;
  t: Messages;
  currency: Currency;
  shift: ShiftDto;
  /** The business takes dollars: with the shift's rate, the pay screen offers Cash USD. */
  usdEnabled?: boolean;
  locationId: string;
  /** The first page of products with their stock and expiry (what a line shows before it is searched again). */
  initialItems: SellItemDto[];
  /** localStorage key of this device's held carts (per business and user). */
  heldKey: string;
  business: string;
  branch: string;
  operator: string;
  /** Managers and owners may record and void expenses (shift.manage); a cashier's till has no expense key. */
  canVoidExpense?: boolean;
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

/** The size of a very large amount: the box width divided by the text length, set as --len. */
const lenStyle = (text: string) => ({ "--len": [...text].length }) as CSSProperties;

const isTyping = (el: EventTarget | null) =>
  el instanceof HTMLElement && (el.isContentEditable || el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT");

/** A mouse or a scanner-equipped desk: focusing the search box does not pop a touch keyboard. */
const finePointer = () => typeof window !== "undefined" && window.matchMedia("(pointer: fine)").matches;

const UNDO_MS = 6000;
const VISIBLE_TABS = 4;

/**
 * The one-screen till: a fixed screen, no scroll, nothing opens over the sale. The middle is the sale
 * (total, one field for the scanner and for names, the selected line, the line table with pages, Pay);
 * the calculator is at the inline-start and the shift total, the selected product's stock and expiry and
 * the last receipts at the inline-end. Open sales are tabs. Paying is the one full-screen step (cash,
 * card, dollars, mixed) and returns here. Phones show two fixed panes switched from a bottom bar.
 */
export function SellScreen({ locale, t, currency, shift, usdEnabled = false, locationId, initialItems, heldKey, business, branch, operator, canVoidExpense = false }: Props) {
  const ctx = { locale, t };
  const s = t.sell;
  const tl = t.till;
  const one = tl.one;
  const router = useRouter();
  const [results, setResults] = useState<SellItemDto[] | null>(null);
  const [lines, setLines] = useState<CartLine[]>([]);
  /** Stock and expiry of the items seen on this till, by line key (a line added from a search brings its own). */
  const [infos, setInfos] = useState<Record<string, SellItemDto>>(() => Object.fromEntries(initialItems.map((i) => [lineKey(i.variantId, i.unitId), i])));
  const heldRaw = useSyncExternalStore(subscribeHeld, () => readHeldRaw(heldKey), () => null);
  const held = useMemo(() => parseHeld(heldRaw), [heldRaw]);
  /** The sale being rung up; every open sale (this one included) is saved in the device store. */
  const [activeId, setActiveId] = useState<string | null>(null);
  const [ticketMsg, setTicketMsg] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("sell");
  const [pane, setPane] = useState<"sell" | "box">("sell");
  const [menuOpen, setMenuOpen] = useState(false);
  /** The Expense panel (managers and owners only, from the menu). */
  const [expenseOpen, setExpenseOpen] = useState(false);
  /** The line the quantity box edits, and the digits typed for it so far. */
  const [selKey, setSelKey] = useState<string | null>(null);
  const [entry, setEntry] = useState("");
  const [armClear, setArmClear] = useState(false);
  const [removed, setRemoved] = useState<{ line: CartLine; at: number } | null>(null);
  const [receipts, setReceipts] = useState<ReceiptDto[]>([]);
  const [cashText, setCashText] = useState("");
  /** Dollars typed (ASCII, two decimals); the keypad types these when the target is USD. */
  const [usdText, setUsdText] = useState("");
  const [target, setTarget] = useState<"IQD" | "USD">("IQD");
  const [cardMinor, setCardMinor] = useState(0n);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [announce, setAnnounce] = useState("");
  const online = useSyncExternalStore(subscribeOnline, () => navigator.onLine, () => true);
  const [receipt, setReceipt] = useState<ReceiptDto | null>(null);
  /** The one field at the top of the sale: a scanner, a typed code or a name. */
  const codeRef = useRef<HTMLInputElement>(null);
  const [code, setCode] = useState("");
  const [codeMiss, setCodeMiss] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  /** The current attempt's key: kept across a network retry, dropped when the cart or the payment changes. */
  const keyRef = useRef<string | null>(null);
  const searchSeq = useRef(0);
  const undoTimer = useRef<number | null>(null);

  const total = useMemo(() => cartTotal(lines), [lines]);
  const count = useMemo(() => cartCount(lines), [lines]);
  const cashMinor = parseAmount(cashText.replace(/\.$/, "") || "0", currency) ?? 0n;
  /** Dollars are offered only with the business switch and the open shift's rate; otherwise the till is as it always was. */
  const rateMicro = usdEnabled && shift.usdRateMicro !== null ? BigInt(shift.usdRateMicro) : null;
  const usdMinor = rateMicro === null ? 0n : (parseAmount(usdText.replace(/\.$/, "") || "0", "USD") ?? 0n);
  const usdDinar = rateMicro === null ? 0n : usdToDinar(usdMinor, rateMicro);
  const tender = rateMicro === null ? { cashMinor, cardMinor } : { cashMinor, cardMinor, usdMinor, usdDinarMinor: usdDinar };
  const pay = payState(total, tender);
  /** What the dollars still have to cover (the due less the card and the dinars typed), as the cent that covers it. */
  const usdDueCents = rateMicro === null ? 0n : dinarToUsdCentsCeil(total > cardMinor + cashMinor ? total - cardMinor - cashMinor : 0n, rateMicro);
  /** The selected line; with none picked, the last one (so the quantity box always has a target). */
  const selLine = lines.find((l) => l.key === selKey) ?? lines[lines.length - 1] ?? null;
  const m = (v: bigint | string) => money(ctx, currency, v);

  useEffect(() => {
    keyRef.current = null;
  }, [lines, cashText, usdText, cardMinor]);

  useEffect(
    () => () => {
      if (undoTimer.current !== null) window.clearTimeout(undoTimer.current);
    },
    [],
  );

  const fetchItems = useCallback(
    async (q: string): Promise<SellItemDto[] | null> => {
      const seq = ++searchSeq.current;
      try {
        const r = await sellItemsAction({ query: q, categoryId: null, locationId, offset: 0 });
        if (seq !== searchSeq.current) return null;
        if (!r.ok) {
          setError(failureMessage(t, r));
          return null;
        }
        return r.value;
      } catch {
        if (seq === searchSeq.current) setError(s.failures.network);
        return null;
      }
    },
    [locationId, t, s.failures.network],
  );

  /** The shift's last receipts (the receipts card); fire and forget, a failure leaves the list as it was. */
  const loadReceipts = useCallback(async () => {
    try {
      const r = await recentSalesAction(4);
      if (r.ok) setReceipts(r.value);
    } catch {
      /* the card keeps what it had */
    }
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loads from the server after mount; the state is set when it answers
    void loadReceipts();
  }, [loadReceipts]);

  // Typed text searches after a short pause; Enter (a scanner) acts at once.
  useEffect(() => {
    if (code.trim() === "") return;
    const id = window.setTimeout(async () => {
      const found = await fetchItems(code.trim());
      if (found) setResults(found);
    }, 250);
    return () => window.clearTimeout(id);
  }, [code, fetchItems]);

  const overlay = mode !== "sell" || menuOpen || expenseOpen;

  // Any printable key typed outside a field goes to the field: a scanner works without a tap first.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (overlay || e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1 || isTyping(e.target)) return;
      codeRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [overlay]);

  // Back on the sale screen: the field is ready for the scanner (not on touch, where it would pop the keyboard).
  useEffect(() => {
    if (!overlay && finePointer()) codeRef.current?.focus({ preventScroll: true });
  }, [overlay]);

  const add = useCallback(
    (item: SellItemDto) => {
      if (item.priceMinor === null) return;
      setError(null);
      setNotice(null);
      setLines((ls) => addItem(ls, item));
      const key = lineKey(item.variantId, item.unitId);
      setInfos((p) => ({ ...p, [key]: item }));
      setSelKey(key);
      setEntry("");
      setCode("");
      setResults(null);
      setCodeMiss(null);
      setAnnounce(fill(s.added, { name: pickName(locale, item) }));
    },
    [locale, s.added],
  );

  /** Enter on the field (a scanner ends with Enter): a barcode hit, else the first priced match, goes into the sale; nothing found says so. */
  const onScan = async (e: FormEvent) => {
    e.preventDefault();
    const c = code.trim();
    if (c === "" || scanning) return;
    setScanning(true);
    setCodeMiss(null);
    try {
      const found = await fetchItems(c);
      if (!found) return;
      const hit = found.find((it) => it.matchedBarcode && it.priceMinor !== null) ?? found.find((it) => it.priceMinor !== null);
      if (!hit) return setCodeMiss(fill(tl.scanNotFound, { code: c }));
      add(hit);
    } catch {
      setCodeMiss(s.failures.network);
    } finally {
      setScanning(false);
      if (finePointer()) codeRef.current?.focus({ preventScroll: true });
    }
  };

  // Parallel sales ------------------------------------------------------------------------------

  /** Puts a ticket on the screen: its lines, a clean quantity box and no leftover messages. */
  const showTicket = (tk: HeldCart | null) => {
    const ls = tk ? ticketLines(tk) : [];
    setActiveId(tk?.id ?? null);
    setLines(ls);
    setSelKey(ls[ls.length - 1]?.key ?? null);
    setEntry("");
    setArmClear(false);
    setError(null);
    setNotice(null);
    setTicketMsg(null);
    setCodeMiss(null);
    setCode("");
    setResults(null);
    setRemoved(null);
    setMenuOpen(false);
    if (finePointer()) codeRef.current?.focus({ preventScroll: true });
  };

  const readStore = () => parseHeld(readHeldRaw(heldKey));

  // On load: the sale worked on last comes back, or the first blank one opens.
  /* eslint-disable react-hooks/set-state-in-effect -- the device store only exists in the browser: read once after mount */
  useEffect(() => {
    const store = readStore();
    const last = latestTicket(store);
    if (last) {
      showTicket(last);
      return;
    }
    const o = openTicket([], newKey(), new Date());
    if (o) {
      writeHeld(heldKey, o.store);
      showTicket(o.ticket);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once per device store
  }, [heldKey]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Every change of the active sale is saved at once (a reload or a switch loses nothing).
  useEffect(() => {
    if (!activeId) return;
    const cur = readStore();
    const next = saveTicket(cur, activeId, lines, new Date());
    if (next !== cur) writeHeld(heldKey, [...next]);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- readStore only reads
  }, [lines, activeId, heldKey]);

  /** Leaves the active sale; a blank one left behind is dropped so empties never pile up. */
  const leaveActive = (store: HeldCart[]) => (activeId && lines.length === 0 && store.length > 1 ? closeTicket(store, activeId) : store);

  const newSale = () => {
    if (lines.length === 0) {
      if (finePointer()) codeRef.current?.focus({ preventScroll: true });
      return;
    }
    const cur = readStore();
    const o = openTicket(cur, newKey(), new Date());
    if (!o) {
      setTicketMsg(fill(tl.ticketsLimit, { max: formatNumber(locale, MAX_TICKETS) }));
      return;
    }
    writeHeld(heldKey, o.store);
    showTicket(o.ticket);
  };

  const switchTo = (id: string) => {
    if (id === activeId) return;
    const cur = readStore();
    const target = cur.find((h) => h.id === id);
    if (!target) return;
    writeHeld(heldKey, touchTicket(leaveActive(cur), id, new Date()));
    showTicket(target);
  };

  /** Paid or voided: this sale's tab closes and the most recent other one (or a blank) comes up. */
  const closeActive = () => {
    const cur = readStore();
    const rest = activeId ? closeTicket(cur, activeId) : cur;
    const other = latestTicket(rest);
    if (other) {
      writeHeld(heldKey, rest);
      return showTicket(other);
    }
    const o = openTicket(rest, newKey(), new Date());
    if (o) {
      writeHeld(heldKey, o.store);
      showTicket(o.ticket);
    }
  };

  // The Clear key asks twice: a second tap within three seconds empties the sale.
  const clearKey = () => {
    if (lines.length === 0) return;
    if (armClear) return closeActive();
    setArmClear(true);
  };
  useEffect(() => {
    if (!armClear) return;
    const id = window.setTimeout(() => setArmClear(false), 3000);
    return () => window.clearTimeout(id);
  }, [armClear]);

  useEffect(() => {
    if (!menuOpen) return;
    menuRef.current?.querySelector<HTMLElement>("button:not(:disabled), a")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  // Lines: select, step, type a quantity, remove with undo ---------------------------------------

  const selectLine = (key: string) => {
    setSelKey(key);
    setEntry("");
  };

  /** X: the line goes at once; the Undo bar puts it back in the same place for a few seconds. */
  const remove = (key: string) => {
    const at = lines.findIndex((l) => l.key === key);
    if (at < 0) return;
    setRemoved({ line: lines[at]!, at });
    setLines((ls) => removeLine(ls, key));
    setSelKey(lines[at + 1]?.key ?? lines[at - 1]?.key ?? null);
    setEntry("");
    if (undoTimer.current !== null) window.clearTimeout(undoTimer.current);
    undoTimer.current = window.setTimeout(() => setRemoved(null), UNDO_MS);
  };

  const undo = () => {
    if (!removed) return;
    const { line, at } = removed;
    setLines((ls) => {
      const next = [...ls];
      next.splice(Math.min(at, next.length), 0, line);
      return next;
    });
    setSelKey(line.key);
    setRemoved(null);
    if (undoTimer.current !== null) window.clearTimeout(undoTimer.current);
  };

  const step = (key: string, d: 1 | -1) => {
    const l = lines.find((x) => x.key === key);
    if (!l) return;
    if (d === -1 && Number(l.quantity) <= 1) return remove(key);
    setLines((ls) => stepLine(ls, key, d));
    setSelKey(key);
    setEntry("");
  };

  /** Typing in the big quantity box sets the selected line's quantity (decimals only where the unit allows). */
  const typeQty = (raw: string) => {
    if (!selLine) return;
    const v = raw.replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660)).replace("٫", ".").replace(",", ".");
    const re = selLine.quantityScale > 0 ? new RegExp(`^\\d{0,9}(\\.\\d{0,${selLine.quantityScale}})?$`) : /^\d{0,9}$/;
    if (!re.test(v)) return;
    setEntry(v);
    if (/^0*\.?0*$/.test(v)) return;
    const updated = setQuantity(lines, selLine.key, v.replace(/\.$/, ""));
    if (updated) setLines(updated);
  };

  // Paying ---------------------------------------------------------------------------------------

  const openPay = () => {
    if (lines.length === 0) return;
    setError(null);
    setCashText("");
    setUsdText("");
    setTarget("IQD");
    setCardMinor(0n);
    setPane("box");
    setMode("pay");
  };

  /** The calculator's result becomes the cash received and the pay step opens. */
  const calcToPaid = (value: number) => {
    if (lines.length === 0 || !(value > 0)) return;
    openPay();
    setCashText(minorToEntry(currency, BigInt(Math.round(value * (currency === "IQD" ? 1 : 100)))));
  };

  const pressCash = (k: NumpadKey) =>
    target === "USD" ? setUsdText((x) => numpadPress(x, k, moneyDecimals("USD"))) : setCashText((x) => numpadPress(x, k, moneyDecimals(currency)));
  const setCash = (v: bigint) => setCashText(minorToEntry(currency, v));
  const setUsd = (v: bigint) => setUsdText(minorToEntry("USD", v));
  /** Exact: the dinars (or the dollars) that cover what the card and the other cash leave. */
  const exact = () => {
    if (target === "USD") return setUsd(usdDueCents);
    setCash(total > cardMinor + usdDinar ? total - cardMinor - usdDinar : 0n);
  };
  const byCard = () => {
    const r = cardRest(total, tender);
    setCardMinor(r.cardMinor);
    setCash(r.cashMinor);
    if (rateMicro !== null) setUsd(r.usdMinor ?? 0n);
  };
  const resetPay = () => {
    setCashText("");
    setUsdText("");
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
        closeActive();
        resetPay();
        setMode("receipt");
        void loadReceipts();
        router.refresh();
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
      if (r.code === "PAYMENT_RULE" && r.details?.reason === "RATE_MISMATCH") {
        setError(s.failures.rateMismatch);
        return;
      }
      if (r.code === "PAYMENT_RULE" && r.details?.reason === "USD_NOT_AVAILABLE") {
        setError(s.failures.usdNotAvailable);
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
        if (target === "USD") setUsdText((x) => numpadPress(x, k, moneyDecimals("USD")));
        else setCashText((x) => numpadPress(x, k, moneyDecimals(currency)));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, sending, currency, target]);

  const afterReceipt = () => {
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
              <span>{receipt.payments.some((p) => p.usdMinor) ? tl.changeDinars : tl.changeDue}</span>
              <strong data-testid="done-change">{m(change)}</strong>
            </p>
          ) : null}
        </div>
        <div className="till-done-actions">
          <button type="button" className="till-btn till-btn-go till-btn-xl" onClick={afterReceipt} autoFocus data-testid="receipt-new">
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

  const totalText = m(total);
  const noLines = lines.length === 0;
  const searching = code.trim() !== "" && results !== null;
  /** One tab per open sale; the active one shows the live lines. At most four show: the active one always, the rest in order. */
  const allTabs = orderTickets(held).map((h) => {
    const live = h.id === activeId ? { count, total } : ticketTotals(h);
    return { id: h.id, no: h.no, count: live.count, total: live.total };
  });
  const tabs = (() => {
    if (allTabs.length <= VISIBLE_TABS) return allTabs;
    const rest = allTabs.filter((x) => x.id !== activeId).slice(0, VISIBLE_TABS - 1);
    const act = allTabs.find((x) => x.id === activeId);
    return act ? [...rest, act].sort((a, b) => a.no - b.no) : rest;
  })();
  const hiddenTabs = allTabs.filter((x) => !tabs.some((v) => v.id === x.id));
  const selInfo = selLine ? infos[selLine.key] : undefined;
  const message = removed
    ? "undo"
    : codeMiss
      ? "miss"
      : error
        ? "error"
        : ticketMsg
          ? "ticket"
          : !online
            ? "offline"
            : "hint";

  return (
    <div className="ot" data-pane={pane} data-testid="till">
      <p className="visually-hidden" role="status" aria-live="polite">
        {announce}
      </p>

      <header className="ot-top">
        <b>{business}</b>
        <span className="ot-meta">
          {branch} · {operator}
        </span>
        {rateMicro !== null ? (
          <span className="ot-pill" data-rate>
            {rateLine(ctx, rateMicro)}
          </span>
        ) : null}
        <span className="ot-pill">{fill(s.shiftSince, { at: formatDateTime(locale, new Date(shift.openedAt)) })}</span>
        <div className="ot-tabs" role="tablist" aria-label={tl.openSales} data-testid="ticket-tabs">
          {tabs.map((tab) => (
            <button key={tab.id} type="button" role="tab" aria-selected={tab.id === activeId} className="ot-tab" onClick={() => switchTo(tab.id)} data-testid="ticket-tab">
              <strong>{fill(tl.saleNo, { n: formatNumber(locale, tab.no) })}</strong>
              <small>{tab.count > 0 ? `${fill(tl.itemCount, { n: formatNumber(locale, tab.count) })} · ${m(tab.total)}` : tl.saleEmpty}</small>
            </button>
          ))}
          {hiddenTabs.length > 0 ? (
            <button type="button" className="ot-tab" onClick={() => switchTo(hiddenTabs[0]!.id)} data-testid="more-sales">
              +{formatNumber(locale, hiddenTabs.length)}
            </button>
          ) : null}
          <button type="button" className="ot-tab" data-new onClick={newSale} data-testid="new-sale">
            + {tl.newSale}
          </button>
        </div>
        <button type="button" className="ot-menu-btn" onClick={() => setMenuOpen(true)} aria-haspopup="dialog" aria-expanded={menuOpen} data-testid="till-menu">
          {tl.menu}
        </button>
      </header>

      <div className="ot-grid">
        <div className="ot-main">
          <div className="ot-head">
            <div className="ot-total" data-refund={total < 0n || undefined} aria-live="polite">
              <small>{s.total}</small>
              <strong data-testid="cart-total" style={lenStyle(totalText)}>
                {totalText}
              </strong>
              <span>{fill(tl.itemCount, { n: formatNumber(locale, count) })}</span>
            </div>
            <div className="ot-center">
              <form className="ot-scan" role="search" onSubmit={onScan}>
                <label className="visually-hidden" htmlFor="till-code">
                  {tl.scanLabel}
                </label>
                <input
                  ref={codeRef}
                  id="till-code"
                  type="text"
                  enterKeyHint="go"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={tl.scanPlaceholder}
                  value={code}
                  aria-invalid={codeMiss !== null || undefined}
                  aria-describedby="till-msg"
                  onChange={(e) => {
                    setCode(e.target.value);
                    setCodeMiss(null);
                    if (e.target.value.trim() === "") {
                      searchSeq.current++;
                      setResults(null);
                    }
                  }}
                  data-testid="scan-input"
                />
              </form>
              <div className="ot-msg" id="till-msg" data-bad={message === "miss" || message === "error" || message === "offline" || undefined}>
                {message === "undo" && removed ? (
                  <div className="ot-undo" role="status" data-testid="undo-bar">
                    <span>{fill(one.removed, { name: pickName(locale, removed.line) })}</span>
                    <button type="button" onClick={undo} data-testid="undo">
                      {one.undo}
                    </button>
                  </div>
                ) : message === "miss" ? (
                  <span role="alert" data-testid="scan-miss">
                    {codeMiss}
                  </span>
                ) : message === "error" ? (
                  <span role="alert">{error}</span>
                ) : message === "ticket" ? (
                  <span role="status" data-testid="tickets-limit">
                    {ticketMsg}
                  </span>
                ) : message === "offline" ? (
                  <span role="status" data-testid="till-offline">
                    {tl.offline}
                  </span>
                ) : (
                  <span>{notice ?? one.hint}</span>
                )}
              </div>
              <div className="ot-cur" aria-label={one.selected}>
                <span className="nm">{selLine ? pickName(locale, selLine) : "—"}</span>
                <span className="v">
                  <small>{tl.colQty}</small>
                  {selLine ? localQuantity(locale, selLine.quantity) : "٠"}
                </span>
                <span className="v">
                  <small>{tl.colPrice}</small>
                  {selLine ? m(selLine.priceMinor) : "—"}
                </span>
                <span className="v">
                  <small>{s.total}</small>
                  {selLine ? m(lineTotal(selLine)) : "—"}
                </span>
              </div>
            </div>
            <div className="ot-qty" role="group" aria-label={one.qtyBox}>
              <input
                type="text"
                inputMode={selLine && selLine.quantityScale > 0 ? "decimal" : "numeric"}
                value={selLine ? (entry !== "" ? entry : selLine.quantity) : "0"}
                disabled={!selLine}
                onChange={(e) => typeQty(e.target.value)}
                onFocus={(e) => e.target.select()}
                onBlur={() => setEntry("")}
                aria-label={one.qtyBox}
                data-testid="qty-input"
              />
              <button type="button" onClick={() => selLine && step(selLine.key, -1)} disabled={!selLine} aria-label={s.decrease.replace("{name}", selLine ? pickName(locale, selLine) : "")} data-testid="key-minus">
                −
              </button>
              <button type="button" onClick={() => selLine && step(selLine.key, 1)} disabled={!selLine} aria-label={s.increase.replace("{name}", selLine ? pickName(locale, selLine) : "")} data-testid="key-plus">
                +
              </button>
              <button type="button" className="del" onClick={() => selLine && remove(selLine.key)} disabled={!selLine} aria-label={tl.fnVoid} data-testid="cart-void">
                ×
              </button>
            </div>
          </div>

          <LineTable
            locale={locale}
            t={t}
            currency={currency}
            lines={lines}
            infoOf={(l) => infos[l.key]}
            selectedKey={selLine?.key ?? null}
            onSelect={selectLine}
            onStep={step}
            onRemove={remove}
            results={searching ? results : null}
            searchText={code.trim()}
            onAddResult={add}
            emptyText={`${s.cartEmptyTitle}. ${s.cartEmptyBody}`}
            noMatchText={s.noMatch}
          />

          <div className="ot-card ot-pay">
            <button type="button" className="ot-clear" data-armed={armClear || undefined} onClick={clearKey} disabled={noLines} data-testid="cart-clear-quick">
              <TrashIcon /> {armClear ? tl.clearCart : tl.fnClear}
            </button>
            <span className="note" />
            <button type="button" className="ot-go" onClick={openPay} disabled={noLines} data-testid="cart-pay">
              {s.pay} · {totalText}
            </button>
          </div>
        </div>

        <aside className="ot-side">
          <ShiftCard locale={locale} t={t} currency={currency} shift={shift} />
          <ProductCard locale={locale} t={t} currency={currency} line={selLine} item={selInfo} />
          <ReceiptsCard locale={locale} t={t} currency={currency} receipts={receipts} />
          {mode === "pay" ? (
<section className="ot-card ot-calc-card ot-paycard" aria-labelledby="pay-title" data-testid="pay-panel">
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
                <div className="till-pay-given" data-multi={rateMicro !== null || undefined} data-active={target === "IQD" || undefined}>
                  <dt>
                    <CashIcon /> {rateMicro === null ? tl.cashReceived : tl.cashIqd}
                  </dt>
                  <dd className="till-display" data-testid="pay-given" data-placeholder={cashText === "" || undefined}>
                    {cashText === "" ? m(0n) : `${entryText(locale, cashText)} ${t.catalog.currencyShort[currency]}`}
                  </dd>
                </div>
                {rateMicro !== null ? (
                  <div className="till-pay-given" data-multi data-active={target === "USD" || undefined}>
                    <dt>
                      <DollarIcon /> {tl.dollarsReceived}
                    </dt>
                    <dd className="till-display" data-testid="pay-given-usd" data-placeholder={usdText === "" || undefined}>
                      {usdText === "" ? money(ctx, "USD", 0n) : `${entryText(locale, usdText)} ${t.catalog.currencyShort.USD}`}
                    </dd>
                  </div>
                ) : null}
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
                    <dt>{usdMinor > 0n ? tl.changeDinars : tl.changeDue}</dt>
                    <dd data-testid="pay-change">{m(pay.change)}</dd>
                  </div>
                )}
              </dl>
              <div className="till-pay-keys">
                <PayMethods
                  locale={locale}
                  t={t}
                  target={target}
                  usd={rateMicro !== null}
                  cardLabel={cashMinor + usdDinar > 0n ? s.payScreen.cardRest : tl.payCard}
                  cardDisabled={pay.remaining === 0n}
                  disabled={sending}
                  onTarget={setTarget}
                  onCard={byCard}
                />
                {rateMicro !== null && target === "USD" ? <UsdDue locale={locale} t={t} dueCents={usdDueCents} rateMicro={rateMicro.toString()} /> : null}
                <div className="till-notes">
                  {target === "USD" && rateMicro !== null
                    ? quickUsdAmounts(usdDueCents).map((v, i) => (
                        <button key={v.toString()} type="button" className="till-note" onClick={() => setUsd(v)} disabled={sending} style={lenStyle(money(ctx, "USD", v))} data-testid="pay-note-usd">
                          {i === 0 && v === usdDueCents ? <span className="till-note-tag">{tl.exact}</span> : null}
                          <span className="till-note-amount">{money(ctx, "USD", v)}</span>
                        </button>
                      ))
                    : quickAmounts(total > cardMinor + usdDinar ? total - cardMinor - usdDinar : 0n, currency).map((v, i) => (
                        <button key={v.toString()} type="button" className="till-note" onClick={() => (i === 0 ? exact() : setCash(v))} disabled={sending} style={lenStyle(m(v))} data-testid="pay-note">
                          {i === 0 ? <span className="till-note-tag">{tl.exact}</span> : null}
                          <span className="till-note-amount">{m(v)}</span>
                        </button>
                      ))}
                </div>
                <Numpad
                  locale={locale}
                  t={t}
                  label={target === "USD" ? tl.dollarsReceived : tl.cashReceived}
                  decimals={moneyDecimals(target === "USD" ? "USD" : currency)}
                  onPress={pressCash}
                  disabled={sending}
                />
                <div className="till-pay-row">
                  <button type="button" className="till-btn till-btn-quiet" onClick={resetPay} disabled={sending || (cashText === "" && usdText === "" && cardMinor === 0n)} data-testid="pay-reset">
                    {tl.clearEntry}
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
          </section>
          ) : (
            <Calculator locale={locale} t={t} onToPaid={calcToPaid} />
          )}
        </aside>
      </div>

      <div className="ot-bar" role="group" aria-label={one.paneBox}>
        <button type="button" aria-pressed={pane === "sell"} onClick={() => setPane("sell")} data-testid="pane-sell">
          {one.paneSell}
        </button>
        <button type="button" aria-pressed={pane === "box"} onClick={() => setPane("box")} data-testid="pane-box">
          {one.paneBox}
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
              <button type="button" className="till-menu-item" onClick={closeActive} disabled={lines.length === 0} data-testid="cart-clear">
                <TrashIcon />
                {tl.clearCart}
              </button>
              {canVoidExpense ? (
                <button
                  type="button"
                  className="till-menu-item"
                  onClick={() => {
                    setMenuOpen(false);
                    setExpenseOpen(true);
                  }}
                  data-testid="fn-expense"
                >
                  <DrawerIcon />
                  {t.expense.key}
                </button>
              ) : null}
              <Link href="/retail/sell/close" className="till-menu-item" data-testid="open-close-shift">
                <DrawerIcon />
                {tl.closeShift}
              </Link>
            </div>
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

      {expenseOpen ? (
        <ExpensePanel locale={locale} t={t} currency={currency} shiftId={shift.id} canVoid={canVoidExpense} who={operator} onClose={() => setExpenseOpen(false)} />
      ) : null}

    </div>
  );
}
