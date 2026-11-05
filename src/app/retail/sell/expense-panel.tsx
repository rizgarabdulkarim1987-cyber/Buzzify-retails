"use client";

import { useEffect, useRef, useState } from "react";
import { formatNumber, type Locale, type Messages } from "@/messages";
import { fill } from "../../_lib/format";
import { Notice } from "../../_ui/state";
import { failureMessage } from "../catalog/_lib/failures";
import { newKey } from "../catalog/_lib/keys";
import { listExpensesAction, recordExpenseAction, voidExpenseAction } from "./actions";
import type { Currency } from "./_lib/cart";
import { EXPENSE_CATEGORIES, MAX_EXPENSE_NOTE, activeTotal, expenseState, type ExpenseDto, type ExpenseForm } from "./_lib/expenses";
import { keyFromKeyboard, moneyDecimals, numpadPress } from "./_lib/till";
import { ExpenseList, Numpad, entryText, money, type VoidDraft } from "./_lib/views";

type Props = {
  locale: Locale;
  t: Messages;
  currency: Currency;
  shiftId: string;
  /** Managers and owners may void a mistake. */
  canVoid: boolean;
  /** The person who rang the shift: the only one who records on it. */
  who: string;
  onClose: () => void;
  /** The shift's expenses when already known (the panel loads them itself otherwise). */
  initialList?: ExpenseDto[] | null;
};

const isTyping = (el: EventTarget | null) =>
  el instanceof HTMLElement && (el.isContentEditable || el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT");

/**
 * The Expense panel of the till: an amount on the keypad (dinars), one of eight categories, a note (needed
 * for "Other"), Save. It posts at once on the open shift and the shift's list below shows it. Save stays
 * fixed under the scrolling middle, so it never covers a key. The attempt key is kept across a network
 * retry and dropped when the form changes, so a double tap records one expense.
 */
export function ExpensePanel({ locale, t, currency, shiftId, canVoid, who, onClose, initialList = null }: Props) {
  const x = t.expense;
  const [form, setForm] = useState<ExpenseForm>({ amountText: "", category: null, note: "" });
  const [list, setList] = useState<ExpenseDto[] | null>(initialList);
  const [loadFailed, setLoadFailed] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [draft, setDraft] = useState<VoidDraft | null>(null);
  const [voidBusy, setVoidBusy] = useState(false);
  const [voidError, setVoidError] = useState<string | null>(null);
  const keyRef = useRef<string | null>(null);
  const voidKeyRef = useRef<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const state = expenseState(form, currency);

  useEffect(() => {
    keyRef.current = null;
  }, [form]);

  useEffect(() => {
    dialogRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    if (initialList !== null) return;
    let alive = true;
    void listExpensesAction(shiftId).then(
      (r) => {
        if (!alive) return;
        if (r.ok) setList(r.value);
        else setLoadFailed(true);
      },
      () => alive && setLoadFailed(true),
    );
    return () => {
      alive = false;
    };
  }, [shiftId, initialList]);

  const press = (k: Parameters<typeof numpadPress>[1]) => {
    setSaved(false);
    setError(null);
    setForm((f) => ({ ...f, amountText: numpadPress(f.amountText, k, moneyDecimals(currency)) }));
  };

  // A physical keyboard types the amount; Escape leaves (not while saving, not while typing in a field).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !sending && !voidBusy) return onClose();
      if (sending || isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      const k = keyFromKeyboard(e.key);
      if (k) {
        e.preventDefault();
        setSaved(false);
        setError(null);
        setForm((f) => ({ ...f, amountText: numpadPress(f.amountText, k, moneyDecimals(currency)) }));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sending, voidBusy, currency, onClose]);

  const save = async () => {
    if (!state.ready || sending || state.amount === null || form.category === null) return;
    keyRef.current ??= newKey();
    const key = keyRef.current;
    setSending(true);
    setError(null);
    setSaved(false);
    try {
      const r = await recordExpenseAction(key, { categoryKey: form.category, amountMinor: state.amount.toString(), note: form.note.trim() });
      if (r.ok) {
        setList((l) => [r.value, ...(l ?? []).filter((e) => e.id !== r.value.id)]);
        setForm({ amountText: "", category: null, note: "" });
        keyRef.current = null;
        setSaved(true);
      } else {
        setError(failureMessage(t, r));
      }
    } catch {
      // The request may or may not have reached the server: the same key makes a retry safe.
      setError(t.sell.failures.network);
    } finally {
      setSending(false);
    }
  };

  const confirmVoid = async () => {
    if (!draft || voidBusy || draft.reason.trim() === "") return;
    voidKeyRef.current ??= newKey();
    setVoidBusy(true);
    setVoidError(null);
    try {
      const r = await voidExpenseAction(voidKeyRef.current, { expenseId: draft.id, reason: draft.reason.trim() });
      if (r.ok) {
        setList((l) => (l ?? []).map((e) => (e.id === r.value.id ? r.value : e)));
        setDraft(null);
        voidKeyRef.current = null;
      } else {
        setVoidError(failureMessage(t, r));
        if (r.code === "EXPENSE_VOIDED") voidKeyRef.current = null;
      }
    } catch {
      setVoidError(t.sell.failures.network);
    } finally {
      setVoidBusy(false);
    }
  };

  const amountText = form.amountText === "" ? money({ locale, t }, currency, 0n) : `${entryText(locale, form.amountText)} ${t.catalog.currencyShort[currency]}`;

  return (
    <div className="till-layer till-layer-full">
      <div className="till-paypad till-xpad" role="dialog" aria-modal="true" aria-labelledby="expense-title" tabIndex={-1} ref={dialogRef} data-testid="expense-panel">
        <div className="till-pay-head">
          <h2 id="expense-title">{x.title}</h2>
          <button type="button" className="till-btn till-btn-quiet" onClick={onClose} disabled={sending} data-testid="expense-back">
            {x.back}
          </button>
        </div>
        <div className="till-pay-body till-x-body">
          <div className="till-x-col">
            <div className="till-x-amountbox" data-testid="expense-amount-box">
              <span>{x.amount}</span>
              <strong className="till-display" data-placeholder={form.amountText === "" || undefined} data-testid="expense-amount-display">
                {amountText}
              </strong>
            </div>
            <Numpad locale={locale} t={t} label={x.amount} decimals={moneyDecimals(currency)} onPress={press} disabled={sending} />
          </div>
          <div className="till-x-col">
            <fieldset className="till-x-cats" disabled={sending}>
              <legend>{x.category}</legend>
              <div className="till-x-catgrid">
                {EXPENSE_CATEGORIES.map((c) => (
                  <button
                    key={c}
                    type="button"
                    className="till-method till-x-cat"
                    aria-pressed={form.category === c}
                    onClick={() => {
                      setSaved(false);
                      setError(null);
                      setForm((f) => ({ ...f, category: c }));
                    }}
                    data-testid={`expense-cat-${c}`}
                  >
                    {x.categories[c]}
                  </button>
                ))}
              </div>
            </fieldset>
            <label className="field till-x-notefield">
              <span>
                {x.note}
                {state.needsNote ? <em className="till-x-need"> · {x.noteRequired}</em> : null}
              </span>
              <input
                className="input"
                type="text"
                maxLength={MAX_EXPENSE_NOTE}
                autoComplete="off"
                value={form.note}
                aria-invalid={state.needsNote || undefined}
                disabled={sending}
                onChange={(e) => {
                  setSaved(false);
                  setError(null);
                  setForm((f) => ({ ...f, note: e.target.value }));
                }}
                data-testid="expense-note"
              />
            </label>
          </div>
          <section className="till-x-today" aria-labelledby="expense-today" data-testid="expense-today">
            <h3 id="expense-today">{x.today}</h3>
            {list === null ? (
              <p className="till-x-empty" aria-busy={!loadFailed}>
                {loadFailed ? x.loadFailed : x.loading}
              </p>
            ) : (
              <ExpenseList
                locale={locale}
                t={t}
                currency={currency}
                list={list}
                who={who}
                draft={draft}
                busy={voidBusy}
                error={voidError}
                onVoid={
                  canVoid
                    ? (id) => {
                        setVoidError(null);
                        setDraft({ id, reason: "" });
                      }
                    : undefined
                }
                onDraft={(reason) => setDraft((d) => (d ? { ...d, reason } : d))}
                onConfirm={() => void confirmVoid()}
                onCancel={() => setDraft(null)}
              />
            )}
          </section>
        </div>
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <p className="visually-hidden" role="status" aria-live="polite">
          {saved ? x.saved : ""}
        </p>
        <button type="button" className="till-btn till-btn-go till-pay till-pay-confirm" onClick={() => void save()} disabled={!state.ready || sending} aria-busy={sending} data-testid="expense-save">
          {sending ? x.saving : saved && !state.ready ? `✓ ${x.saved}` : x.save}
        </button>
      </div>
    </div>
  );
}

/**
 * The shift's expenses on the close screen: one collapsed line ("40 expenses - total") that opens the list
 * (scrolling inside its own box, so 40 rows never push the count field off a phone). Managers and owners can
 * void a row of an open shift; onVoided lets the page refresh so the expected cash follows.
 */
export function ExpenseSection({
  locale,
  t,
  currency,
  initial,
  canVoid,
  who,
  onVoided,
}: {
  locale: Locale;
  t: Messages;
  currency: Currency;
  initial: ExpenseDto[];
  canVoid: boolean;
  who: string;
  /** Called after a void is saved (the close page refreshes so the expected cash follows). */
  onVoided?: () => void;
}) {
  const [list, setList] = useState(initial);
  const [draft, setDraft] = useState<VoidDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keyRef = useRef<string | null>(null);
  if (list.length === 0) return null;

  const confirm = async () => {
    if (!draft || busy || draft.reason.trim() === "") return;
    keyRef.current ??= newKey();
    setBusy(true);
    setError(null);
    try {
      const r = await voidExpenseAction(keyRef.current, { expenseId: draft.id, reason: draft.reason.trim() });
      if (r.ok) {
        setList((l) => l.map((e) => (e.id === r.value.id ? r.value : e)));
        setDraft(null);
        keyRef.current = null;
        onVoided?.();
      } else {
        setError(failureMessage(t, r));
        if (r.code === "EXPENSE_VOIDED") keyRef.current = null;
      }
    } catch {
      setError(t.sell.failures.network);
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className="till-x-section" data-testid="close-expenses">
      <summary data-testid="close-expenses-toggle">
        <strong>{t.expense.expenses}</strong>
        <span className="till-x-sum">
          <span>{fill(t.expense.count, { n: formatNumber(locale, list.length) })}</span>
          <b data-testid="close-expenses-total">{money({ locale, t }, currency, activeTotal(list))}</b>
        </span>
      </summary>
      <div className="till-x-scroll">
        <ExpenseList
          locale={locale}
          t={t}
          currency={currency}
          list={list}
          who={who}
          draft={draft}
          busy={busy}
          error={error}
          onVoid={
            canVoid
              ? (id) => {
                  setError(null);
                  setDraft({ id, reason: "" });
                }
              : undefined
          }
          onDraft={(reason) => setDraft((d) => (d ? { ...d, reason } : d))}
          onConfirm={() => void confirm()}
          onCancel={() => setDraft(null)}
        />
      </div>
    </details>
  );
}
