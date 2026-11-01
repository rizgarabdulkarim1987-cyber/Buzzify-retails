"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { formatNumber, type Locale, type Messages } from "@/messages";
import { fill, pickName } from "../../_lib/format";
import { SearchIcon } from "../../_ui/icons";
import { Notice } from "../../_ui/state";
import { listStockAction } from "./actions";
import { AdjustDialog, type AdjustTarget } from "./adjust-dialog";
import type { AdjustDone, Currency, StockRowDto } from "./_lib/types";
import { StockList, StockListEmpty } from "./_lib/views";

type Initial = { query: string; expiringOnly: boolean; rows: StockRowDto[]; nextCursor: string | null };

type Props = {
  locale: Locale;
  t: Messages;
  currency: Currency;
  canSeeCost: boolean;
  canAdjust: boolean;
  readOnly: boolean;
  initial: Initial;
};

const DEBOUNCE_MS = 250;

/**
 * The stock list with instant search, on the catalog list's pattern: the server renders the first
 * page, typing asks again after a short pause, the "expiring" switch asks at once, and "show more"
 * follows the cursor. Only the newest request may write the list (a slow answer never replaces a
 * newer one, and the old rows stay dimmed, never swapped for stale ones). With the expiring filter
 * a page may come back short or empty while more remain: the list says so and keeps "show more".
 * After an adjustment the list is read again, and the adjust buttons stay disabled until it is.
 */
export function StockBrowser({ locale, t, currency, canSeeCost, canAdjust, readOnly, initial }: Props) {
  const l = t.stock.list;
  const [query, setQuery] = useState(initial.query);
  const [expiringOnly, setExpiringOnly] = useState(initial.expiringOnly);
  const [rows, setRows] = useState(initial.rows);
  const [nextCursor, setNextCursor] = useState(initial.nextCursor);
  const [busy, setBusy] = useState<"idle" | "search" | "more" | "refresh">("idle");
  const [failed, setFailed] = useState(false);
  const [target, setTarget] = useState<AdjustTarget | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const latest = useRef(0);
  const first = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastQuery = useRef(initial.query);

  const run = useCallback(async (q: string, expiring: boolean, cursor: string | null, kind: "search" | "more" | "refresh") => {
    const id = ++latest.current;
    setBusy(kind);
    setFailed(false);
    try {
      const result = await listStockAction({ query: q, expiringOnly: expiring, cursor });
      if (id !== latest.current) return;
      if (!result.ok) {
        setFailed(true);
      } else {
        setRows((prev) => (cursor ? [...prev, ...result.value.rows.filter((r) => !prev.some((p) => p.variantId === r.variantId))] : result.value.rows));
        setNextCursor(result.value.nextCursor);
      }
    } catch {
      if (id === latest.current) setFailed(true);
    } finally {
      if (id === latest.current) setBusy("idle");
    }
  }, []);

  // A new query or filter: search again (typed text waits for a pause; the switch is immediate).
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    clearTimeout(timer.current);
    const typed = query !== lastQuery.current;
    lastQuery.current = query;
    timer.current = setTimeout(() => void run(query, expiringOnly, null, "search"), typed ? DEBOUNCE_MS : 0);
    const params = new URLSearchParams();
    if (query) params.set("q", query);
    if (expiringOnly) params.set("expiring", "1");
    const qs = params.toString();
    window.history.replaceState(null, "", qs ? `?${qs}` : window.location.pathname);
    return () => clearTimeout(timer.current);
  }, [query, expiringOnly, run]);

  const onDone = (done: AdjustDone) => {
    setTarget(null);
    const parts = [fill(t.stock.adjust.done, { number: formatNumber(locale, done.number) })];
    if (done.costUnknown && canSeeCost) parts.push(t.stock.adjust.costUnknown);
    setNotice(parts.join(" "));
    // The quantities on screen are now old: read the list again; adjusting waits until it is back.
    clearTimeout(timer.current);
    void run(query, expiringOnly, null, "refresh");
  };

  const filtered = query !== "" || expiringOnly;
  const shortPage = rows.length === 0 && nextCursor !== null;

  return (
    <div className="catalog stock">
      <form
        className="catalog-tools"
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          clearTimeout(timer.current);
          void run(query, expiringOnly, null, "search");
        }}
      >
        <label className="field catalog-search">
          <span className="visually-hidden">{l.searchLabel}</span>
          <div className="input-icon">
            <SearchIcon />
            <input
              className="input"
              type="search"
              inputMode="search"
              enterKeyHint="search"
              name="q"
              value={query}
              maxLength={100}
              autoComplete="off"
              placeholder={l.searchPlaceholder}
              onChange={(event) => setQuery(event.target.value)}
              data-testid="stock-search"
            />
          </div>
        </label>
        <label className="check">
          <input type="checkbox" name="expiring" value="1" checked={expiringOnly} onChange={(event) => setExpiringOnly(event.target.checked)} data-testid="stock-expiring-toggle" />
          {l.expiringOnly}
        </label>
      </form>

      <div className="visually-hidden" role="status" aria-live="polite">
        {busy === "search" ? l.searching : busy === "refresh" ? l.refreshing : busy === "idle" && filtered ? fill(l.resultsCount, { count: formatNumber(locale, rows.length) }) : ""}
      </div>
      {notice ? <Notice tone="success">{notice}</Notice> : null}
      {failed ? <Notice tone="danger">{l.searchFailed}</Notice> : null}

      {rows.length === 0 && nextCursor === null && busy !== "search" && !failed ? (
        <StockListEmpty t={t} filtered={filtered} />
      ) : (
        <StockList
          locale={locale}
          t={t}
          rows={rows}
          currency={currency}
          canSeeCost={canSeeCost}
          canAdjust={canAdjust}
          adjustDisabled={readOnly}
          adjustWaiting={busy !== "idle"}
          onAdjust={(r) => {
            setNotice(null);
            setTarget({ productId: r.productId, variantId: r.variantId, name: pickName(locale, r) });
          }}
          busy={busy !== "idle" && busy !== "more"}
        />
      )}
      {shortPage && busy === "idle" && !failed ? <p className="muted stock-keep-looking">{l.keepLooking}</p> : null}

      {nextCursor ? (
        <div className="catalog-more">
          <button
            type="button"
            className="btn btn-secondary"
            disabled={busy !== "idle"}
            aria-busy={busy === "more"}
            onClick={() => void run(query, expiringOnly, nextCursor, "more")}
            data-testid="stock-load-more"
          >
            {busy === "more" ? l.loadingMore : l.loadMore}
          </button>
        </div>
      ) : null}

      {target ? <AdjustDialog locale={locale} t={t} target={target} onClose={() => setTarget(null)} onDone={onDone} /> : null}
    </div>
  );
}
