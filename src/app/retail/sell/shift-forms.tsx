"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { Locale, Messages } from "@/messages";
import { fill } from "../../_lib/format";
import { Notice } from "../../_ui/state";
import { failureMessage } from "../catalog/_lib/failures";
import { newKey } from "../catalog/_lib/keys";
import { closeShiftAction, openShiftAction } from "./actions";
import { parseAmount, type Currency, type ShiftDto } from "./_lib/cart";
import { keyFromKeyboard, moneyDecimals, numpadPress, type NumpadKey } from "./_lib/till";
import { differenceText, entryText, money, Numpad, ShiftSummaryView } from "./_lib/views";

/** The attempt key: kept for a retry of the same values, new when the values change. */
function useAttemptKey() {
  const ref = useRef<{ key: string; sig: string } | null>(null);
  return (sig: string) => {
    if (!ref.current || ref.current.sig !== sig) ref.current = { key: newKey(), sig };
    return ref.current.key;
  };
}

/** Numpad text for a money amount, with the physical keyboard (and a USB numpad) feeding the same keys. */
function useMoneyEntry(currency: Currency, onEnter: () => void, active = true) {
  const [text, setText] = useState("");
  const press = (k: NumpadKey) => setText((x) => numpadPress(x, k, moneyDecimals(currency)));
  const enterRef = useRef(onEnter);
  useEffect(() => {
    enterRef.current = onEnter;
  });
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      if (e.key === "Enter") {
        e.preventDefault();
        return enterRef.current();
      }
      const k = keyFromKeyboard(e.key);
      if (k) {
        e.preventDefault();
        setText((x) => numpadPress(x, k, moneyDecimals(currency)));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [currency, active]);
  const minor = text === "" ? null : parseAmount(text.replace(/\.$/, ""), currency);
  return { text, setText, press, minor };
}

/** Open shift: the cash in the drawer on the numpad, then straight to selling. */
export function OpenShiftForm({ locale, t, currency }: { locale: Locale; t: Messages; currency: Currency }) {
  const s = t.sell;
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const keyFor = useAttemptKey();
  const enter = useRef<() => void>(() => {});
  const entry = useMoneyEntry(currency, () => enter.current());

  const submit = async (v: bigint) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await openShiftAction(keyFor(v.toString()), v.toString());
      // Already open (another tab): the till shows it.
      if (r.ok || r.code === "SHIFT_ALREADY_OPEN") {
        router.refresh();
        return;
      }
      setError(failureMessage(t, r));
      setBusy(false);
    } catch {
      setError(s.failures.network);
      setBusy(false);
    }
  };

  useEffect(() => {
    enter.current = () => void submit(entry.minor ?? 0n);
  });

  return (
    <div className="till-shift-form" data-testid="open-shift-form">
      <div className="till-entry">
        <span className="till-entry-label">{t.till.openCashTitle}</span>
        <output className="till-display" data-placeholder={entry.text === "" || undefined} aria-live="polite" data-testid="open-cash">
          {entry.text === "" ? money({ locale, t }, currency, 0n) : `${entryText(locale, entry.text)} ${t.catalog.currencyShort[currency]}`}
        </output>
      </div>
      <Numpad locale={locale} t={t} label={s.open.cash} decimals={moneyDecimals(currency)} onPress={entry.press} disabled={busy} />
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <div className="till-pad-actions">
        <button type="button" className="till-btn till-btn-quiet" onClick={() => void submit(0n)} disabled={busy} data-testid="open-empty">
          {s.open.empty}
        </button>
        <button type="button" className="till-btn till-btn-go" onClick={() => void submit(entry.minor ?? 0n)} disabled={busy || (entry.text !== "" && entry.minor === null)} aria-busy={busy} data-testid="open-submit">
          {s.open.submit}
        </button>
      </div>
    </div>
  );
}

/** Close shift: the summary, the counted cash on the numpad, the difference as it is typed, then close. */
export function CloseShiftForm({ locale, t, shift }: { locale: Locale; t: Messages; shift: ShiftDto }) {
  const s = t.sell.close;
  const ctx = { locale, t };
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [closed, setClosed] = useState<{ differenceMinor: string; shift: ShiftDto } | null>(null);
  const keyFor = useAttemptKey();
  const enter = useRef<() => void>(() => {});
  const entry = useMoneyEntry(shift.currency, () => enter.current(), closed === null);

  const submit = async () => {
    const counted = entry.minor;
    if (counted === null || busy) {
      if (counted === null) setError(t.sell.failures.badAmount);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const sig = `${counted}:${note}`;
      const r = await closeShiftAction(keyFor(sig), {
        shiftId: shift.id,
        countedCashMinor: counted.toString(),
        note: note.trim() === "" ? null : note.trim(),
        expectedVersion: shift.version,
      });
      // No refresh here: the page would re-render as "no open shift" and hide this result.
      if (r.ok) setClosed(r.value);
      else setError(failureMessage(t, r));
    } catch {
      setError(t.sell.failures.network);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    enter.current = () => void submit();
  });
  const diff = entry.minor === null ? null : entry.minor - BigInt(shift.expectedCashMinor);
  const diffView = diff === null ? null : differenceText(ctx, shift.currency, diff);

  if (closed) {
    const d = differenceText(ctx, closed.shift.currency, BigInt(closed.differenceMinor));
    return (
      <div className="till-closed" data-testid="shift-closed">
        <h2>{s.closedTitle}</h2>
        <p className="till-diff" data-tone={d.tone}>
          {fill(s.closedBody, { difference: d.text })}
        </p>
        <ShiftSummaryView locale={locale} t={t} shift={closed.shift} />
        <Link href="/retail/sell" className="till-btn till-btn-go" data-testid="open-new-shift">
          {s.openNew}
        </Link>
      </div>
    );
  }

  return (
    <div className="till-close">
      <ShiftSummaryView locale={locale} t={t} shift={shift} />
      <div className="till-shift-form" data-testid="close-shift-form">
        <div className="till-entry">
          <span className="till-entry-label">{t.till.countedTitle}</span>
          <output className="till-display" data-placeholder={entry.text === "" || undefined} aria-describedby="close-diff" data-testid="close-counted">
            {entry.text === "" ? money(ctx, shift.currency, 0n) : `${entryText(locale, entry.text)} ${t.catalog.currencyShort[shift.currency]}`}
          </output>
        </div>
        <p id="close-diff" className="till-diff" data-tone={diffView?.tone} aria-live="polite" data-testid="close-difference">
          {s.difference}: {diffView ? diffView.text : t.common.none}
        </p>
        <Numpad locale={locale} t={t} label={s.counted} decimals={moneyDecimals(shift.currency)} onPress={entry.press} disabled={busy} />
        <label className="field">
          <span>{s.note}</span>
          <textarea className="input" rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <div className="till-pad-actions">
          <Link href="/retail/sell" className="till-btn till-btn-quiet">
            {s.back}
          </Link>
          <button type="button" className="till-btn till-btn-go" onClick={() => void submit()} disabled={busy || entry.minor === null} aria-busy={busy} data-testid="close-submit">
            {s.submit}
          </button>
        </div>
      </div>
    </div>
  );
}
