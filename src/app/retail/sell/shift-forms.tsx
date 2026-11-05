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
import { ExpenseSection } from "./expense-panel";
import { microToRateText, parseAmount, rateToMicro, type Currency, type ShiftDto } from "./_lib/cart";
import type { ExpenseDto } from "./_lib/expenses";
import { keyFromKeyboard, moneyDecimals, numpadPress, type NumpadKey } from "./_lib/till";
import { differenceText, entryText, money, Numpad, rateLine, ShiftSummaryView } from "./_lib/views";

/** The attempt key: kept for a retry of the same values, new when the values change. */
function useAttemptKey() {
  const ref = useRef<{ key: string; sig: string } | null>(null);
  return (sig: string) => {
    if (!ref.current || ref.current.sig !== sig) ref.current = { key: newKey(), sig };
    return ref.current.key;
  };
}

/**
 * Numpad text for the amounts of a form, with the physical keyboard (and a USB numpad) feeding the same
 * keys. The numpad types into one field at a time (`field`); `decimals` says how many decimals each takes.
 */
function useMoneyFields<F extends string>(decimals: Record<F, number>, first: NoInfer<F>, onEnter: () => void, active = true, initial: Partial<Record<F, string>> = {}) {
  const [texts, setTexts] = useState<Record<F, string>>(() => {
    const out = {} as Record<F, string>;
    for (const f of Object.keys(decimals) as F[]) out[f] = initial[f] ?? "";
    return out;
  });
  const [field, setField] = useState<F>(first);
  const fieldRef = useRef(field);
  const decimalsRef = useRef(decimals);
  const enterRef = useRef(onEnter);
  useEffect(() => {
    fieldRef.current = field;
    decimalsRef.current = decimals;
    enterRef.current = onEnter;
  });
  // A pre-filled amount (the last rate) is replaced by the first digit typed, so it never has to be deleted key by key.
  const prefilled = useRef(new Set<F>((Object.keys(initial) as F[]).filter((f) => initial[f])));
  const type = (k: NumpadKey) => {
    const f = fieldRef.current;
    const replace = prefilled.current.delete(f) && k !== "back" && k !== "clear";
    setTexts((x) => ({ ...x, [f]: numpadPress(replace ? "" : x[f], k, decimalsRef.current[f]) }));
  };
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
        type(k);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active]);
  return { texts, field, setField, press: type };
}

/** The value of a typed amount: null when empty, undefined when it does not parse. */
function amountOf(text: string, currency: Currency): bigint | null | undefined {
  if (text === "") return null;
  return parseAmount(text.replace(/\.$/, ""), currency) ?? undefined;
}

/** One amount of a form: its label and what was typed; with several on screen it is a button that points the numpad at it. */
function Entry({
  label,
  hint,
  display,
  placeholder,
  testId,
  pick,
  selected,
}: {
  label: string;
  hint?: string;
  display: string;
  placeholder: boolean;
  testId: string;
  /** Present when the form has more than one amount: tapping the entry makes it the one the numpad types. */
  pick?: () => void;
  selected?: boolean;
}) {
  const body = (
    <>
      <span className="till-entry-label">{label}</span>
      {hint ? <span className="till-entry-hint">{hint}</span> : null}
      <output className="till-display" data-placeholder={placeholder || undefined} aria-live="polite" data-testid={testId}>
        {display}
      </output>
    </>
  );
  if (!pick) return <div className="till-entry">{body}</div>;
  return (
    <button type="button" className="till-entry till-entry-pick" aria-pressed={selected} onClick={pick} data-testid={`${testId}-pick`}>
      {body}
    </button>
  );
}

/** Open shift: the cash in the drawer on the numpad (and, when dollars are taken, the dollars and the day's rate), then straight to selling. */
export function OpenShiftForm({
  locale,
  t,
  currency,
  usdEnabled = false,
  lastRateMicro = null,
}: {
  locale: Locale;
  t: Messages;
  currency: Currency;
  /** The business takes dollars: the form also asks for the opening dollars and the rate. */
  usdEnabled?: boolean;
  /** The rate of the last closed shift (IQD per USD x 10^6), pre-filled and editable. */
  lastRateMicro?: string | null;
}) {
  const s = t.sell;
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const keyFor = useAttemptKey();
  const enter = useRef<() => void>(() => {});
  const fields = useMoneyFields(
    { cash: moneyDecimals(currency), usd: 2, rate: 2 },
    "cash",
    () => enter.current(),
    true,
    { rate: usdEnabled && lastRateMicro ? microToRateText(BigInt(lastRateMicro)) : "" },
  );
  const ctx = { locale, t };
  const cash = amountOf(fields.texts.cash, currency);
  const usd = usdEnabled ? amountOf(fields.texts.usd, "USD") : null;
  const rateText = usdEnabled ? fields.texts.rate : "";
  const rate = rateText === "" ? null : rateToMicro(rateText.replace(/\.$/, ""));
  // A rate that is typed must be believable; dollars in the drawer need a rate.
  const dollarsBad = usd === undefined || (rateText !== "" && rate === null) || ((usd ?? 0n) > 0n && rate === null);
  const invalid = cash === undefined || dollarsBad;

  const submit = async (opening: bigint, withDollars: boolean) => {
    if (busy) return;
    if (dollarsBad && withDollars) {
      setError(s.failures.badRate);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const dollars = withDollars && rate !== null ? { openingUsdMinor: (usd ?? 0n).toString(), usdRateMicro: rate.toString() } : undefined;
      const r = await openShiftAction(keyFor(`${opening}:${dollars ? `${dollars.openingUsdMinor}@${dollars.usdRateMicro}` : ""}`), opening.toString(), dollars);
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
    enter.current = () => void submit(cash ?? 0n, true);
  });

  const pick = (f: "cash" | "usd" | "rate") => (usdEnabled ? () => fields.setField(f) : undefined);
  return (
    <div className="till-shift-form" data-testid="open-shift-form">
      <Entry
        label={t.till.openCashTitle}
        display={fields.texts.cash === "" ? money(ctx, currency, 0n) : `${entryText(locale, fields.texts.cash)} ${t.catalog.currencyShort[currency]}`}
        placeholder={fields.texts.cash === ""}
        testId="open-cash"
        pick={pick("cash")}
        selected={fields.field === "cash"}
      />
      {usdEnabled ? (
        <div className="till-entry-pair">
          <Entry
            label={t.till.openingDollars}
            display={fields.texts.usd === "" ? money(ctx, "USD", 0n) : `${entryText(locale, fields.texts.usd)} ${t.catalog.currencyShort.USD}`}
            placeholder={fields.texts.usd === ""}
            testId="open-usd"
            pick={pick("usd")}
            selected={fields.field === "usd"}
          />
          <Entry
            label={t.till.rate}
            hint={t.till.rateHint}
            display={rateText === "" ? "—" : `${entryText(locale, rateText)} ${t.catalog.currencyShort[currency]}`}
            placeholder={rateText === ""}
            testId="open-rate"
            pick={pick("rate")}
            selected={fields.field === "rate"}
          />
        </div>
      ) : null}
      <Numpad
        locale={locale}
        t={t}
        label={fields.field === "usd" ? t.till.openingDollars : fields.field === "rate" ? t.till.rate : s.open.cash}
        decimals={fields.field === "cash" ? moneyDecimals(currency) : 2}
        onPress={fields.press}
        disabled={busy}
      />
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <div className="till-pad-actions">
        <button type="button" className="till-btn till-btn-quiet" onClick={() => void submit(0n, false)} disabled={busy} data-testid="open-empty">
          {s.open.empty}
        </button>
        <button type="button" className="till-btn till-btn-go" onClick={() => void submit(cash ?? 0n, true)} disabled={busy || invalid} aria-busy={busy} data-testid="open-submit">
          {s.open.submit}
        </button>
      </div>
    </div>
  );
}

/** Close shift: the summary, the counted cash (and dollars) on the numpad, the differences as they are typed, then close. */
export function CloseShiftForm({
  locale,
  t,
  shift,
  expenses = [],
  canVoidExpense = false,
  who = "",
}: {
  locale: Locale;
  t: Messages;
  shift: ShiftDto;
  /** The shift's expenses (voided ones included), newest first. */
  expenses?: ExpenseDto[];
  canVoidExpense?: boolean;
  who?: string;
}) {
  const s = t.sell.close;
  const ctx = { locale, t };
  const router = useRouter();
  const hasUsd = shift.usdRateMicro !== null;
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [closed, setClosed] = useState<{ differenceMinor: string; differenceUsdMinor: string | null; shift: ShiftDto } | null>(null);
  const keyFor = useAttemptKey();
  const enter = useRef<() => void>(() => {});
  const fields = useMoneyFields({ cash: moneyDecimals(shift.currency), usd: 2 }, "cash", () => enter.current(), closed === null);
  const counted = amountOf(fields.texts.cash, shift.currency);
  const countedUsd = hasUsd ? amountOf(fields.texts.usd, "USD") : null;
  const complete = counted !== null && counted !== undefined && (!hasUsd || (countedUsd !== null && countedUsd !== undefined));

  const submit = async () => {
    if (busy) return;
    if (!complete) {
      setError(t.sell.failures.badAmount);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const sig = `${counted}:${countedUsd ?? ""}:${note}`;
      const r = await closeShiftAction(keyFor(sig), {
        shiftId: shift.id,
        countedCashMinor: counted!.toString(),
        ...(hasUsd ? { countedUsdMinor: countedUsd!.toString() } : {}),
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
  const diff = typeof counted === "bigint" ? counted - BigInt(shift.expectedCashMinor) : null;
  const diffView = diff === null ? null : differenceText(ctx, shift.currency, diff);
  const diffUsd = typeof countedUsd === "bigint" && shift.expectedUsdMinor !== null ? countedUsd - BigInt(shift.expectedUsdMinor) : null;
  const diffUsdView = diffUsd === null ? null : differenceText(ctx, "USD", diffUsd);

  if (closed) {
    const d = differenceText(ctx, closed.shift.currency, BigInt(closed.differenceMinor));
    const du = closed.differenceUsdMinor === null ? null : differenceText(ctx, "USD", BigInt(closed.differenceUsdMinor));
    return (
      <div className="till-closed" data-testid="shift-closed">
        <h2>{s.closedTitle}</h2>
        <p className="till-diff" data-tone={d.tone} data-testid="closed-difference">
          {du ? `${t.till.drawerIqd}: ` : ""}
          {fill(s.closedBody, { difference: d.text })}
        </p>
        {du ? (
          <p className="till-diff" data-tone={du.tone} data-testid="closed-difference-usd">
            {t.till.drawerUsd}: {fill(s.closedBody, { difference: du.text })}
          </p>
        ) : null}
        <ShiftSummaryView locale={locale} t={t} shift={closed.shift} />
        <ExpenseSection locale={locale} t={t} currency={closed.shift.currency} initial={expenses} canVoid={false} who={who} />
        <Link href="/retail/sell" className="till-btn till-btn-go" data-testid="open-new-shift">
          {s.openNew}
        </Link>
      </div>
    );
  }

  return (
    <div className="till-close">
      <div className="till-close-side">
        <ShiftSummaryView locale={locale} t={t} shift={shift} />
        <ExpenseSection locale={locale} t={t} currency={shift.currency} initial={expenses} canVoid={canVoidExpense} who={who} onVoided={() => router.refresh()} />
      </div>
      <div className="till-shift-form" data-testid="close-shift-form">
        <div className={hasUsd ? "till-entry-pair" : undefined}>
          <Entry
            label={t.till.countedTitle}
            display={fields.texts.cash === "" ? money(ctx, shift.currency, 0n) : `${entryText(locale, fields.texts.cash)} ${t.catalog.currencyShort[shift.currency]}`}
            placeholder={fields.texts.cash === ""}
            testId="close-counted"
            pick={hasUsd ? () => fields.setField("cash") : undefined}
            selected={fields.field === "cash"}
          />
          {hasUsd ? (
            <Entry
              label={t.till.countedDollars}
              display={fields.texts.usd === "" ? money(ctx, "USD", 0n) : `${entryText(locale, fields.texts.usd)} ${t.catalog.currencyShort.USD}`}
              placeholder={fields.texts.usd === ""}
              testId="close-counted-usd"
              pick={() => fields.setField("usd")}
              selected={fields.field === "usd"}
            />
          ) : null}
        </div>
        <p id="close-diff" className="till-diff" data-tone={diffView?.tone} aria-live="polite" data-testid="close-difference">
          {hasUsd ? `${t.till.drawerIqd}: ` : `${s.difference}: `}
          {diffView ? diffView.text : t.common.none}
        </p>
        {hasUsd ? (
          <p className="till-diff" data-tone={diffUsdView?.tone} aria-live="polite" data-testid="close-difference-usd">
            {t.till.drawerUsd}: {diffUsdView ? diffUsdView.text : t.common.none}
          </p>
        ) : null}
        {hasUsd && shift.usdRateMicro ? <p className="muted">{rateLine(ctx, shift.usdRateMicro)}</p> : null}
        <Numpad locale={locale} t={t} label={fields.field === "usd" ? t.till.countedDollars : s.counted} decimals={fields.field === "usd" ? 2 : moneyDecimals(shift.currency)} onPress={fields.press} disabled={busy} />
        <label className="field">
          <span>{s.note}</span>
          <textarea className="input" rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <div className="till-pad-actions">
          <Link href="/retail/sell" className="till-btn till-btn-quiet">
            {s.back}
          </Link>
          <button type="button" className="till-btn till-btn-go" onClick={() => void submit()} disabled={busy || !complete} aria-busy={busy} data-testid="close-submit">
            {s.submit}
          </button>
        </div>
      </div>
    </div>
  );
}
