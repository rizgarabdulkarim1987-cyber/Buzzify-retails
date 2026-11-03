"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";
import type { Locale, Messages } from "@/messages";
import { fill } from "../../_lib/format";
import { CashIcon } from "../../_ui/icons";
import { Notice } from "../../_ui/state";
import { failureMessage } from "../catalog/_lib/failures";
import { newKey } from "../catalog/_lib/keys";
import { closeShiftAction, openShiftAction } from "./actions";
import { parseAmount, type Currency, type ShiftDto } from "./_lib/cart";
import { differenceText, money, ShiftSummaryView } from "./_lib/views";

/** The attempt key: kept for a retry of the same values, new when the values change. */
function useAttemptKey() {
  const ref = useRef<{ key: string; sig: string } | null>(null);
  return (sig: string) => {
    if (!ref.current || ref.current.sig !== sig) ref.current = { key: newKey(), sig };
    return ref.current.key;
  };
}

/** Open shift: the cash in the drawer, then straight to selling. */
export function OpenShiftForm({ locale, t, currency }: { locale: Locale; t: Messages; currency: Currency }) {
  const s = t.sell;
  const router = useRouter();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const keyFor = useAttemptKey();

  const submit = async (value: string) => {
    const v = parseAmount(value, currency);
    if (v === null) {
      setError(s.failures.badAmount);
      return;
    }
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

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void submit(text.trim() === "" ? "0" : text);
  };

  return (
    <form className="till-shift-form" onSubmit={onSubmit} data-testid="open-shift-form">
      <label className="till-amount-field">
        <span>{s.open.cash}</span>
        <span className="till-amount-box">
          <CashIcon />
          <input
            className="till-amount-input"
            inputMode={currency === "IQD" ? "numeric" : "decimal"}
            autoComplete="off"
            autoFocus
            placeholder={money({ locale, t }, currency, 0n)}
            value={text}
            onChange={(e) => setText(e.target.value)}
            data-testid="open-cash"
          />
          <span className="till-amount-unit">{t.catalog.currencyShort[currency]}</span>
        </span>
      </label>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <div className="till-form-actions">
        <button type="button" className="btn btn-secondary till-big" onClick={() => void submit("0")} disabled={busy} data-testid="open-empty">
          {s.open.empty}
        </button>
        <button type="submit" className="btn btn-primary till-big" disabled={busy} aria-busy={busy} data-testid="open-submit">
          {s.open.submit}
        </button>
      </div>
    </form>
  );
}

/** Close shift: the summary, the count, the difference as it is typed, then close. */
export function CloseShiftForm({ locale, t, shift }: { locale: Locale; t: Messages; shift: ShiftDto }) {
  const s = t.sell.close;
  const ctx = { locale, t };
  const [text, setText] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [closed, setClosed] = useState<{ differenceMinor: string; shift: ShiftDto } | null>(null);
  const keyFor = useAttemptKey();

  const counted = text.trim() === "" ? null : parseAmount(text, shift.currency);
  const diff = counted === null ? null : counted - BigInt(shift.expectedCashMinor);
  const diffView = diff === null ? null : differenceText(ctx, shift.currency, diff);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (counted === null) {
      setError(t.sell.failures.badAmount);
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
      if (r.ok) {
        setClosed(r.value);
      } else {
        setError(failureMessage(t, r));
      }
    } catch {
      setError(t.sell.failures.network);
    } finally {
      setBusy(false);
    }
  };

  if (closed) {
    const d = differenceText(ctx, closed.shift.currency, BigInt(closed.differenceMinor));
    return (
      <div className="till-closed" data-testid="shift-closed">
        <h2>{s.closedTitle}</h2>
        <p className="till-diff" data-tone={d.tone}>
          {fill(s.closedBody, { difference: d.text })}
        </p>
        <ShiftSummaryView locale={locale} t={t} shift={closed.shift} />
        <Link href="/retail/sell" className="btn btn-primary till-big" data-testid="open-new-shift">
          {s.openNew}
        </Link>
      </div>
    );
  }

  return (
    <div className="till-close">
      <ShiftSummaryView locale={locale} t={t} shift={shift} />
      <form className="till-shift-form" onSubmit={onSubmit} data-testid="close-shift-form">
        <label className="till-amount-field">
          <span>{s.counted}</span>
          <span className="till-amount-box">
            <CashIcon />
            <input
              className="till-amount-input"
              inputMode={shift.currency === "IQD" ? "numeric" : "decimal"}
              autoComplete="off"
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              aria-invalid={text.trim() !== "" && counted === null}
              aria-describedby="close-diff"
              data-testid="close-counted"
            />
            <span className="till-amount-unit">{t.catalog.currencyShort[shift.currency]}</span>
          </span>
        </label>
        <p id="close-diff" className="till-diff" data-tone={diffView?.tone} aria-live="polite" data-testid="close-difference">
          {s.difference}: {diffView ? diffView.text : t.common.none}
        </p>
        <label className="field">
          <span>{s.note}</span>
          <textarea className="input" rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <div className="till-form-actions">
          <Link href="/retail/sell" className="btn btn-secondary till-big">
            {s.back}
          </Link>
          <button type="submit" className="btn btn-primary till-big" disabled={busy || counted === null} aria-busy={busy} data-testid="close-submit">
            {s.submit}
          </button>
        </div>
      </form>
    </div>
  );
}
