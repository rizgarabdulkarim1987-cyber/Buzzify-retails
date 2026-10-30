"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type RefObject } from "react";
import { formatNumber, type Locale, type Messages } from "@/messages";
import { fill, pickName } from "../../../../_lib/format";
import { Notice } from "../../../../_ui/state";
import { useHydrated } from "../../../catalog/_lib/hydrated";
import { newKey } from "../../../catalog/_lib/keys";
import { nextAttempt, receiveHref, type ItemInfo } from "../../_lib/receipt-rules";
import type { Currency, StockFailure, StockResult } from "../../_lib/types";
import {
  acknowledgeIntakeTotalAction,
  createDraftFromIntakeAction,
  createIntakeItemsAction,
  intakeItemAction,
  intakeReviewAction,
  resolveIntakeLineAction,
  runIntakeReadAction,
  setIntakeCurrencyAction,
} from "../../actions";
import { receiveSearchAction, type ReceiveHit } from "../actions";
import type { IntakeReview } from "./_lib/load";
import {
  draftGate,
  focusAfter,
  intakeFailureMessage,
  isOpen,
  lineChoices,
  localDigits,
  newItemLines,
  pollDelay,
  readingPlan,
  refusalFocus,
  shownLines,
  type IntakeLineDto,
  type IntakeStatus,
  type ReviewFocus,
} from "./_lib/rules";
import { DraftBar, LineBadge, ReasonList, TotalBar } from "./_lib/views";

type Props = {
  t: Messages;
  locale: Locale;
  initial: IntakeReview;
  /** The business accepts no writes now: the review is shown, nothing can be changed. */
  readOnly: boolean;
  canCreateItems: boolean;
  enabledCurrencies: Currency[];
};

const photoHref = (id?: string) => (id ? `/retail/stock/receive/photo/${encodeURIComponent(id)}` : "/retail/stock/receive/photo");

/** Waits `ms`, or rejects at once when the signal aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

/**
 * One receipt intake: while it is read, a waiting state (the read runs as a Server Action; its
 * status is checked through a Route Handler, which is not queued behind it), then the failure or
 * the review. The read's key is kept for a retry after a lost answer (one reservation).
 */
export function IntakeScreen(props: Props) {
  const { t, locale, initial } = props;
  const m = t.stock.intake;
  const id = initial.intake.id;
  const [review, setReview] = useState(initial);
  const [runFailure, setRunFailure] = useState<StockFailure | null>(null);
  const [runLost, setRunLost] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const runKey = useRef<string | null>(null);
  const runStarted = useRef(false);
  const cancelledRef = useRef(false);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const plan = readingPlan(review.intake.status, props.readOnly);
  const waiting = plan === "RUN" || plan === "POLL";

  const refresh = useCallback(async (): Promise<boolean> => {
    const fresh = await intakeReviewAction(id);
    if (!fresh.ok) {
      setRunFailure(fresh);
      return false;
    }
    setReview(fresh.value);
    return true;
  }, [id]);

  const run = useCallback(async () => {
    setRunLost(false);
    setRunFailure(null);
    // The same read asked again after no answer keeps its key.
    runKey.current ??= newKey();
    try {
      const res = await runIntakeReadAction(runKey.current, id);
      if (cancelledRef.current) return;
      if (!res.ok) setRunFailure(res);
      if (res.ok && res.value.status === "READING") return; // another attempt is reading: the status check follows it
      await refresh();
    } catch {
      if (!cancelledRef.current) setRunLost(true);
    }
  }, [id, refresh]);

  // Start the read of a freshly uploaded intake (once), and follow its status until it ends.
  useEffect(() => {
    if (!waiting || cancelled) return;
    if (plan === "RUN" && !runStarted.current) {
      runStarted.current = true;
      void run();
    }
    const ctrl = new AbortController();
    void (async () => {
      for (let n = 0; ; n += 1) {
        try {
          await sleep(pollDelay(n), ctrl.signal);
          const res = await fetch(`${photoHref(id)}/status`, { signal: ctrl.signal, cache: "no-store" });
          const body = (await res.json()) as { ok: boolean; status?: IntakeStatus; code?: StockFailure["code"] };
          if (ctrl.signal.aborted) return;
          if (!body.ok) {
            setRunFailure({ code: body.code ?? "INTERNAL" });
            return;
          }
          if (body.status !== "READING" && body.status !== "UPLOADED") {
            await refresh();
            return;
          }
        } catch {
          if (ctrl.signal.aborted) return;
          // A dropped check is tried again on the next tick.
        }
      }
    })();
    return () => ctrl.abort();
  }, [waiting, cancelled, plan, id, run, refresh]);

  // When the screen changes (reading, failure, review), focus its title; not on the first load.
  const shownPlan = useRef(plan);
  useEffect(() => {
    if (shownPlan.current === plan) return;
    shownPlan.current = plan;
    titleRef.current?.focus();
  }, [plan]);

  if (waiting) {
    const r = m.reading;
    return (
      <section className="section panel intake intake-reading" aria-labelledby="intake-reading-title" data-testid="intake-reading" aria-busy={!cancelled || undefined}>
        {!cancelled && !runFailure ? <div className="intake-spinner" aria-hidden="true" /> : null}
        <h2 id="intake-reading-title" ref={titleRef} tabIndex={-1}>
          {r.title}
        </h2>
        <p role="status">{cancelled ? r.cancelled : r.body}</p>
        {runFailure ? <Notice tone="danger">{intakeFailureMessage(t, runFailure, locale)}</Notice> : null}
        {runLost ? <Notice tone="danger">{r.noAnswer}</Notice> : null}
        <div className="intake-line-actions">
          {runLost ? (
            <button type="button" className="btn btn-primary" onClick={() => void run()} data-testid="intake-read-retry">
              {r.retry}
            </button>
          ) : null}
          {cancelled ? (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                cancelledRef.current = false;
                setCancelled(false);
              }}
              data-testid="intake-read-resume"
            >
              {r.resume}
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => {
                cancelledRef.current = true;
                setCancelled(true);
              }}
              data-testid="intake-read-cancel"
            >
              {r.cancel}
            </button>
          )}
          <Link href="/retail/stock/receive" className="btn btn-secondary">
            {m.manual}
          </Link>
        </div>
      </section>
    );
  }

  if (plan === "READ_ONLY") {
    // A read-only business: the read is not started (it would only be refused) and nothing is counted.
    const r = m.reading;
    return (
      <section className="section intake" data-testid="intake-read-only">
        <h2 ref={titleRef} tabIndex={-1}>
          {r.title}
        </h2>
        <Notice tone="danger">{r.readOnly}</Notice>
        <div className="intake-line-actions">
          <Link href="/retail/stock/receive" className="btn btn-secondary">
            {m.manual}
          </Link>
        </div>
      </section>
    );
  }

  if (plan === "FAILED") {
    const r = m.reading;
    const code = (review.intake.failureCode ?? "AI_UNAVAILABLE") as StockFailure["code"];
    return (
      <section className="section intake" data-testid="intake-failed">
        <h2 ref={titleRef} tabIndex={-1}>
          {r.failedTitle}
        </h2>
        <Notice tone="danger">{intakeFailureMessage(t, { code }, locale)}</Notice>
        <div className="intake-line-actions">
          <Link href={photoHref()} className="btn btn-primary" data-testid="intake-again">
            {r.again}
          </Link>
          <Link href="/retail/stock/receive" className="btn btn-secondary">
            {m.manual}
          </Link>
        </div>
      </section>
    );
  }

  return <Review {...props} review={review} setReview={setReview} titleRef={titleRef} />;
}

// ---------------------------------------------------------------------------------------------
// Review

type Focus = ReviewFocus;

function Review({
  t,
  locale,
  readOnly,
  canCreateItems,
  enabledCurrencies,
  review,
  setReview,
  titleRef,
}: Props & { review: IntakeReview; setReview: (r: IntakeReview) => void; titleRef: RefObject<HTMLHeadingElement | null> }) {
  const m = t.stock.intake;
  const r = m.review;
  const router = useRouter();
  const hydrated = useHydrated();
  const uid = useId();
  const intake = review.intake;
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<StockFailure | null>(null);
  const [noAnswer, setNoAnswer] = useState(false);
  // A write was saved but the intake could not be read again: nothing more is sent from the old version.
  const [stale, setStale] = useState(false);
  const [announce, setAnnounce] = useState("");
  const [onlyOpen, setOnlyOpen] = useState(false);
  const [focus, setFocus] = useState<{ to: Focus; run: number } | null>(null);
  const busyRef = useRef(false);
  const attempt = useRef<{ payload: string; key: string } | null>(null);
  const linesRef = useRef<HTMLOListElement>(null);
  const linesHead = useRef<HTMLHeadingElement>(null);
  const draftRef = useRef<HTMLButtonElement>(null);
  const currencyRef = useRef<HTMLSelectElement>(null);
  const totalRef = useRef<HTMLDivElement>(null);
  const failureRef = useRef<HTMLDivElement>(null);

  const canAct = hydrated && !readOnly && !stale && intake.status === "READ";
  const gate = draftGate({ hydrated, readOnly, busy: busy || stale }, intake);
  const open = intake.lines.filter(isOpen);
  const lines = shownLines(intake.lines, onlyOpen);
  const toCreate = canCreateItems ? newItemLines(intake.lines) : [];

  const focusTo = (to: Focus) => setFocus((f) => ({ to, run: (f?.run ?? 0) + 1 }));

  // Focus never falls on <body>: after each decision it moves to the next open line, else a safe summary.
  useEffect(() => {
    if (!focus) return;
    const to = focus.to;
    if (to.kind === "line") {
      const h = linesRef.current?.querySelector<HTMLElement>(`[data-line="${to.n}"] h3`);
      if (h) return h.focus();
      return linesHead.current?.focus();
    }
    // A target that is missing or disabled falls back to the notices area (always there, focusable).
    const notices = () => failureRef.current?.focus();
    const tryFocus = (el: HTMLElement | null | undefined) => {
      if (!el || !el.isConnected || el.matches(":disabled, [aria-disabled=\"true\"]")) return notices();
      el.focus();
      if (document.activeElement !== el) notices();
    };
    if (to.kind === "draft") return tryFocus(draftRef.current);
    if (to.kind === "currency") return tryFocus(currencyRef.current);
    if (to.kind === "total") return tryFocus(totalRef.current?.querySelector<HTMLElement>("button:not([aria-disabled=\"true\"]), h3"));
    if (to.kind === "failure") return notices();
    linesHead.current?.focus();
  }, [focus]);

  /**
   * One write at a time. The same intent at the same version keeps its idempotency key (a retry
   * after a lost answer replays it); a new intent, or a newer version, gets a new key. After a
   * success the intake is read again (every line is re-evaluated on the server).
   */
  async function write<T>(
    intent: string,
    send: (key: string, expectedVersion: number) => Promise<StockResult<T>>,
    done: (value: T) => { text?: string; focus?: Focus } | void,
  ): Promise<void> {
    if (busyRef.current || !canAct) return;
    busyRef.current = true;
    setBusy(true);
    setFailure(null);
    setNoAnswer(false);
    const version = intake.version;
    attempt.current = nextAttempt(attempt.current, `${intent}@${version}`, newKey);
    let res: StockResult<T>;
    try {
      res = await send(attempt.current.key, version);
    } catch {
      // No answer: the key is kept, so the same action again replays instead of applying twice.
      setNoAnswer(true);
      focusTo({ kind: "failure" });
      busyRef.current = false;
      setBusy(false);
      return;
    }
    attempt.current = null;
    try {
      if (!res.ok) {
        if (res.code === "VERSION_CONFLICT" || res.code === "INVALID_TRANSITION") await reload();
        setFailure(res.code === "VERSION_CONFLICT" ? { code: "VERSION_CONFLICT" } : res);
        const to = refusalFocus(res);
        if (to.kind === "line") setOnlyOpen(false);
        focusTo(to);
        return;
      }
      // Saved. The screen must show the new version before anything else is sent from it.
      const after = done(res.value);
      const fresh = await reload();
      if (after?.text) setAnnounce(after.text);
      if (!fresh) return focusTo({ kind: "failure" });
      if (after?.focus) {
        if (after.focus.kind === "line") {
          const next = focusAfter(fresh.intake.lines, after.focus.n);
          focusTo(next === null ? { kind: "draft" } : { kind: "line", n: next });
        } else focusTo(after.focus);
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  /** Reads the intake again; when that fails the screen is marked stale (no write from the old version). */
  async function reload(): Promise<IntakeReview | null> {
    try {
      const fresh = await intakeReviewAction(intake.id);
      if (fresh.ok) {
        setReview(fresh.value);
        setStale(false);
        return fresh.value;
      }
    } catch {
      // Treated as a failed reload below.
    }
    setStale(true);
    return null;
  }

  async function reloadNow() {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      if (await reload()) {
        setFailure(null);
        setNoAnswer(false);
        focusTo({ kind: "lines" });
      } else focusTo({ kind: "failure" });
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  const resolve = (line: IntakeLineDto, action: Parameters<typeof resolveIntakeLineAction>[1]["action"], intent: string) =>
    write(
      `line:${line.lineNo}:${intent}`,
      (key, expectedVersion) => resolveIntakeLineAction(key, { intakeId: intake.id, lineNo: line.lineNo, action, expectedVersion }),
      () => ({ text: fill(r.resolved, { n: formatNumber(locale, line.lineNo) }), focus: { kind: "line", n: line.lineNo } }),
    );

  const createItems = (lineNos: number[], from: number) =>
    write(
      `items:${lineNos.join(",")}`,
      (key, expectedVersion) => createIntakeItemsAction(key, { intakeId: intake.id, lineNos, expectedVersion }),
      (v) => ({ text: fill(r.created, { count: formatNumber(locale, v.created) }), focus: { kind: "line", n: from } }),
    );

  async function createDraft() {
    if (!gate.ok) {
      if (gate.reason === "UNRESOLVED") {
        setOnlyOpen(false);
        focusTo({ kind: "line", n: gate.lineNo });
      } else if (gate.reason === "CURRENCY") focusTo({ kind: "currency" });
      else if (gate.reason === "TOTAL") focusTo({ kind: "total" });
      return;
    }
    if (busyRef.current || !canAct) return;
    busyRef.current = true;
    setBusy(true);
    setFailure(null);
    setNoAnswer(false);
    attempt.current = nextAttempt(attempt.current, `draft@${intake.version}`, newKey);
    try {
      const res = await createDraftFromIntakeAction(attempt.current.key, { intakeId: intake.id, expectedVersion: intake.version });
      attempt.current = null;
      if (res.ok) {
        router.push(receiveHref({ draft: res.value.documentId }));
        return;
      }
      setFailure(res.code === "VERSION_CONFLICT" ? { code: "VERSION_CONFLICT" } : res);
      await reload();
      const to = refusalFocus(res);
      if (to.kind === "line") setOnlyOpen(false);
      focusTo(to);
    } catch {
      setNoAnswer(true);
      focusTo({ kind: "failure" });
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  const showCurrencyPicker = intake.status === "READ" && (intake.receiptCurrency === null || enabledCurrencies.length > 1);

  return (
    <div className="intake" data-testid="intake-review" data-version={intake.version}>
      <div aria-live="polite" className="visually-hidden" data-testid="intake-announce">
        {announce}
      </div>
      <h2 className="visually-hidden" ref={titleRef} tabIndex={-1}>
        {r.title}
      </h2>
      {intake.duplicateOf ? (
        <div className="section" data-testid="intake-duplicate">
          <Notice tone="danger">
            {r.duplicate}{" "}
            <Link href={photoHref(intake.duplicateOf)} className="business-link">
              {r.openEarlier}
            </Link>
          </Notice>
        </div>
      ) : null}
      {intake.status === "DRAFTED" && intake.stockDocumentId ? (
        <div className="section" data-testid="intake-drafted">
          <Notice tone="success">{r.drafted}</Notice>
          <div className="intake-line-actions">
            <Link href={receiveHref({ draft: intake.stockDocumentId })} className="btn btn-primary" data-testid="intake-open-draft">
              {r.openDraft}
            </Link>
          </div>
        </div>
      ) : null}

      <div className="intake-review">
        <PageViewer t={t} locale={locale} intakeId={intake.id} pageCount={intake.pageCount} />

        <div className="intake">
          <section className="section panel intake" aria-labelledby={`${uid}-details`}>
            <h3 id={`${uid}-details`}>{r.details}</h3>
            <dl className="intake-details">
              <Detail label={r.supplier} value={intake.supplier} none={r.notPrinted} />
              <Detail label={r.date} value={intake.date} none={r.notPrinted} />
              <Detail label={r.receiptNo} value={intake.receiptNo} none={r.notPrinted} />
              <Detail label={r.currencyPrinted} value={intake.currencyPrinted} none={r.notPrinted} />
            </dl>
            {showCurrencyPicker ? (
              <label className="field">
                <span>{r.currency}</span>
                <select
                  ref={currencyRef}
                  className="input"
                  value={intake.receiptCurrency ?? ""}
                  aria-disabled={!canAct || busy || undefined}
                  aria-describedby={intake.receiptCurrency === null ? `${uid}-currency-hint` : undefined}
                  onChange={(e) => {
                    const currency = e.target.value as Currency;
                    if (!canAct || busy || (currency !== "IQD" && currency !== "USD")) return;
                    void write(
                      `currency:${currency}`,
                      (key, expectedVersion) => setIntakeCurrencyAction(key, { intakeId: intake.id, currency, expectedVersion }),
                      () => ({ text: r.currencySaved, focus: { kind: "currency" } }),
                    );
                  }}
                  data-testid="intake-currency"
                >
                  {intake.receiptCurrency === null ? <option value="">{r.currencyPick}</option> : null}
                  {enabledCurrencies.map((c) => (
                    <option key={c} value={c}>
                      {t.currency[c]}
                    </option>
                  ))}
                </select>
                {intake.receiptCurrency === null ? (
                  <span className="hint" id={`${uid}-currency-hint`}>
                    {r.currencyHint}
                  </span>
                ) : null}
              </label>
            ) : intake.receiptCurrency ? (
              <p className="muted">
                {r.currency}: {t.currency[intake.receiptCurrency]}
              </p>
            ) : null}
          </section>

          <section className="section intake" aria-labelledby={`${uid}-lines`}>
            <div className="section-head">
              <h3 id={`${uid}-lines`} ref={linesHead} tabIndex={-1}>
                {fill(r.lines, { count: formatNumber(locale, intake.lines.length) })}
              </h3>
              <p className="muted" data-testid="intake-open-count">
                {open.length > 0 ? fill(r.openCount, { count: formatNumber(locale, open.length) }) : r.allResolved}
              </p>
            </div>
            <label className="check intake-filter">
              <input type="checkbox" checked={onlyOpen} onChange={(e) => setOnlyOpen(e.target.checked)} aria-describedby={`${uid}-filter-hint`} data-testid="intake-only-open" />
              {r.onlyOpen}
            </label>
            <p className="hint" id={`${uid}-filter-hint`}>
              {r.onlyOpenHint}
            </p>
            {toCreate.length > 0 && intake.status === "READ" ? (
              <div className="intake-read">
                <p className="hint" id={`${uid}-create-hint`}>
                  {r.createAllHint}
                </p>
                <div>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    aria-disabled={!canAct || busy || undefined}
                    aria-describedby={`${uid}-create-hint`}
                    onClick={() => void createItems(toCreate, toCreate[0]!)}
                    data-testid="intake-create-all"
                  >
                    {fill(r.createAll, { count: formatNumber(locale, toCreate.length) })}
                  </button>
                </div>
              </div>
            ) : null}
            {lines.length === 0 ? (
              <p className="muted" data-testid="intake-no-open">
                {r.noOpen}
              </p>
            ) : (
              <ol className="intake-lines" ref={linesRef}>
                {lines.map((l) => (
                  <LineCard
                    key={`${l.lineNo}:${intake.version}`}
                    t={t}
                    locale={locale}
                    line={l}
                    item={l.variantId ? review.items[l.variantId] : undefined}
                    canAct={canAct}
                    busy={busy}
                    choices={lineChoices(l, { canCreateItems, hasCurrency: intake.receiptCurrency !== null })}
                    onResolve={(action, intent) => void resolve(l, action, intent)}
                    onCreate={() => void createItems([l.lineNo], l.lineNo)}
                  />
                ))}
              </ol>
            )}
          </section>

          <div ref={totalRef} className="section">
            <TotalBar
              t={t}
              intake={intake}
              canAct={canAct}
              busy={busy}
              onAccept={() =>
                void write(
                  "total",
                  (key, expectedVersion) => acknowledgeIntakeTotalAction(key, { intakeId: intake.id, expectedVersion }),
                  () => ({ text: r.totalAccepted, focus: { kind: "draft" } }),
                )
              }
            />
          </div>

          <div ref={failureRef} tabIndex={-1} className="intake" data-testid="intake-notices">
            {failure ? (
              <div className="section" data-testid="intake-failure">
                <Notice tone="danger">{failure.code === "VERSION_CONFLICT" ? r.conflict : intakeFailureMessage(t, failure, locale)}</Notice>
              </div>
            ) : null}
            {noAnswer ? (
              <div className="section" data-testid="intake-no-answer">
                <Notice tone="danger">{r.noAnswer}</Notice>
              </div>
            ) : null}
            {stale ? (
              <div className="section" data-testid="intake-stale">
                <Notice tone="danger">{r.reloadFailed}</Notice>
                <div className="intake-line-actions">
                  <button type="button" className="btn btn-primary" aria-busy={busy || undefined} onClick={() => void reloadNow()} data-testid="intake-reload">
                    {r.reload}
                  </button>
                </div>
              </div>
            ) : null}
          </div>

          <section className="section panel">
            <DraftBar t={t} locale={locale} gate={gate} busy={busy} onDraft={() => void createDraft()} buttonRef={draftRef} />
          </section>
        </div>
      </div>
    </div>
  );
}

function Detail({ label, value, none }: { label: string; value: string | undefined; none: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd dir="auto" className={value ? undefined : "muted"}>
        {value ?? none}
      </dd>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Image

const ZOOMS = [100, 150, 200, 300] as const;

/** Why a page image did not show: the page is a PDF (asked with HEAD, no bytes), or it is gone. */
async function pageKindOf(src: string): Promise<"pdf" | "gone"> {
  try {
    const res = await fetch(src, { method: "HEAD", cache: "no-store" });
    return res.ok && res.headers.get("Content-Type") === "application/pdf" ? "pdf" : "gone";
  } catch {
    return "gone";
  }
}

/** The receipt's pages, one at a time, with zoom (the image scrolls inside its box, never the page). */
function PageViewer({ t, locale, intakeId, pageCount }: { t: Messages; locale: Locale; intakeId: string; pageCount: number }) {
  const r = t.stock.intake.review;
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(0);
  // A page the <img> could not show: a PDF (said so, with the full page to open) or gone/broken.
  const [broken, setBroken] = useState<Record<number, "pdf" | "gone">>({});
  if (pageCount < 1) return null;
  // Zoom means nothing for a page that is not shown as an image (a PDF, or a page that is gone).
  const noZoom = broken[page] !== undefined;
  const src = `${photoHref(intakeId)}/image/${page}`;
  const label = fill(r.pageN, { n: formatNumber(locale, page) });
  return (
    <section className="intake-viewer-panel" aria-label={r.image} data-testid="intake-viewer">
      <div className="intake-viewer-tools">
        {pageCount > 1
          ? Array.from({ length: pageCount }, (_, i) => i + 1).map((n) => (
              <button
                key={n}
                type="button"
                className={`btn btn-small ${n === page ? "btn-primary" : "btn-secondary"}`}
                aria-pressed={n === page}
                onClick={() => setPage(n)}
                data-testid="intake-viewer-page"
              >
                {fill(r.pageN, { n: formatNumber(locale, n) })}
              </button>
            ))
          : null}
        <button
          type="button"
          className="btn btn-secondary btn-small"
          aria-disabled={noZoom || zoom === 0 || undefined}
          onClick={() => !noZoom && setZoom((z) => Math.max(0, z - 1))}
          data-testid="intake-zoom-out"
        >
          {r.zoomOut}
        </button>
        <button
          type="button"
          className="btn btn-secondary btn-small"
          aria-disabled={noZoom || zoom === ZOOMS.length - 1 || undefined}
          onClick={() => !noZoom && setZoom((z) => Math.min(ZOOMS.length - 1, z + 1))}
          data-testid="intake-zoom-in"
        >
          {r.zoomIn}
        </button>
        <a href={src} target="_blank" rel="noopener" className="btn btn-secondary btn-small">
          {r.openPage}
        </a>
      </div>
      <div className="intake-viewer" tabIndex={0} aria-label={label}>
        {broken[page] ? (
          <p className="muted intake-viewer-note" data-testid={broken[page] === "pdf" ? "intake-viewer-pdf" : "intake-viewer-gone"}>
            {broken[page] === "pdf" ? r.pdfPage : r.imageGone}
          </p>
        ) : (
          // eslint-disable-next-line @next/next/no-img-element -- a private, access-checked page image, not an optimisable asset
          <img
            key={src}
            src={src}
            alt={label}
            style={{ inlineSize: `${ZOOMS[zoom]}%` }}
            onError={() => {
              const shown = page;
              void pageKindOf(src).then((kind) => setBroken((b) => ({ ...b, [shown]: kind })));
            }}
            data-testid="intake-viewer-image"
          />
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// One line

type ResolveAction = Parameters<typeof resolveIntakeLineAction>[1]["action"];

function LineCard({
  t,
  locale,
  line,
  item,
  canAct,
  busy,
  choices,
  onResolve,
  onCreate,
}: {
  t: Messages;
  locale: Locale;
  line: IntakeLineDto;
  item: ItemInfo | undefined;
  canAct: boolean;
  busy: boolean;
  choices: ReturnType<typeof lineChoices>;
  onResolve: (action: ResolveAction, intent: string) => void;
  onCreate: () => void;
}) {
  const r = t.stock.intake.review;
  const uid = useId();
  const [editing, setEditing] = useState(false);
  const [picked, setPicked] = useState<ItemInfo | null>(null);
  const [unitId, setUnitId] = useState(line.unitId ?? "");
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<ReceiveHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const unitRef = useRef<HTMLSelectElement>(null);
  const inert = !canAct || busy;
  const decide = !line.discarded && (!line.resolved || editing);
  const shownItem = picked ?? item;
  const isNewPick = picked !== null && picked.variantId !== line.variantId;

  useEffect(() => {
    if (confirmDiscard) cancelRef.current?.focus();
  }, [confirmDiscard]);

  async function pick(variantId: string, unitHint?: string) {
    setLoadFailed(false);
    try {
      const res = await intakeItemAction(variantId);
      if (!res.ok) return setLoadFailed(true);
      setPicked(res.value);
      setUnitId(unitHint && res.value.units.some((u) => u.id === unitHint) ? unitHint : "");
      setSearchOpen(false);
      setHits(null);
      requestAnimationFrame(() => unitRef.current?.focus());
    } catch {
      setLoadFailed(true);
    }
  }

  async function search(event: FormEvent) {
    event.preventDefault();
    const q = query.trim();
    if (q === "" || searching) return;
    setSearching(true);
    try {
      const res = await receiveSearchAction(q);
      setHits(res.ok ? res.value.filter((h) => !h.archived && !h.isTestData) : []);
    } catch {
      setHits([]);
    } finally {
      setSearching(false);
    }
  }

  const acceptBlocked = inert || !shownItem || unitId === "";
  const accept = () => {
    if (acceptBlocked || !shownItem) return;
    if (isNewPick) onResolve({ kind: "PICK_ITEM", variantId: shownItem.variantId, unitId }, `item:${shownItem.variantId}:${unitId}`);
    // PICK_UNIT confirms the item shown beside the picker too.
    else onResolve({ kind: "PICK_UNIT", unitId }, `unit:${unitId}`);
  };

  return (
    <li className="intake-line" data-line={line.lineNo} data-open={isOpen(line) || undefined} data-discarded={line.discarded || undefined} data-testid="intake-line">
      <div className="intake-line-head">
        <span className="intake-line-no">{fill(r.lineN, { n: formatNumber(locale, line.lineNo) })}</span>
        <h3 tabIndex={-1} dir="auto">
          {line.description}
        </h3>
        <LineBadge t={t} line={line} />
      </div>
      <dl className="intake-printed">
        <Printed label={r.qty} value={line.quantity} />
        {line.unitText !== undefined ? <Printed label={r.unitPrinted} value={line.unitText} /> : null}
        {line.unitPrice !== undefined ? <Printed label={r.price} value={line.priceFromTotal ? localDigits(locale, line.unitPrice) : line.unitPrice} note={line.priceFromTotal ? r.fromTotal : undefined} /> : null}
        {line.lineTotal !== undefined ? <Printed label={r.lineTotal} value={line.lineTotal} /> : null}
        {line.barcode !== undefined ? <Printed label={r.barcode} value={line.barcode} ltr /> : null}
      </dl>
      {line.priceFromTotal && line.printedUnitPrice !== undefined ? <p className="muted">{fill(r.printedPrice, { price: line.printedUnitPrice })}</p> : null}
      {!line.discarded && !line.resolved ? <ReasonList t={t} reasons={line.reasons} /> : null}

      {!line.discarded && line.resolved && !editing ? (
        <div className="intake-line-actions">
          {item ? (
            <p className="muted" dir="auto">
              {r.chosen}: {pickName(locale, item)} · {item.units.find((u) => u.id === line.unitId)?.name ?? ""}
            </p>
          ) : null}
          {canAct ? (
            <button type="button" className="btn btn-secondary btn-small" aria-disabled={inert || undefined} onClick={() => !inert && setEditing(true)} data-testid="intake-line-edit">
              {r.edit}
            </button>
          ) : null}
        </div>
      ) : null}

      {decide && canAct ? (
        <>
          {shownItem ? (
            <div className="intake-item" data-testid="intake-line-item">
              <span className="muted">{picked ? r.chosen : r.suggested}</span>
              <span className="intake-item-name" dir="auto">
                {pickName(locale, shownItem)} <span className="muted" dir="ltr">{shownItem.sku}</span>
              </span>
              <div className="intake-item-row">
                <label className="field">
                  <span>{r.unit}</span>
                  <select ref={unitRef} className="input" value={unitId} onChange={(e) => setUnitId(e.target.value)} data-testid="intake-line-unit">
                    {unitId === "" ? <option value="">{r.pickUnit}</option> : null}
                    {shownItem.units.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.name}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  className="btn btn-primary"
                  aria-disabled={acceptBlocked || undefined}
                  aria-describedby={unitId === "" ? `${uid}-unit-hint` : undefined}
                  onClick={accept}
                  data-testid="intake-line-accept"
                >
                  {r.accept}
                </button>
              </div>
              {unitId === "" ? (
                <span className="hint" id={`${uid}-unit-hint`}>
                  {r.pickUnit}
                </span>
              ) : null}
            </div>
          ) : line.variantId ? (
            <p className="muted">{r.itemUnavailable}</p>
          ) : (
            <p className="muted">{r.noItem}</p>
          )}
          {loadFailed ? <p className="field-error">{r.itemUnavailable}</p> : null}

          {choices.candidates && !picked ? (
            <div className="intake">
              <span className="muted">{r.candidates}</span>
              <ul className="intake-candidates">
                {line.candidates.map((c) => (
                  <li key={c.variantId}>
                    <button type="button" className="receipt-hit" aria-disabled={inert || undefined} onClick={() => !inert && void pick(c.variantId)} data-testid="intake-candidate">
                      <span className="truncate" dir="auto">
                        {c.nameAr}
                      </span>
                      <span className="muted" dir="ltr">
                        {c.sku}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {searchOpen ? (
            <form className="receipt-scan-form" role="search" onSubmit={(e) => void search(e)}>
              <label className="field">
                <span>{r.search}</span>
                <input className="input" type="search" dir="auto" autoComplete="off" maxLength={100} value={query} placeholder={r.searchHint} onChange={(e) => setQuery(e.target.value)} autoFocus data-testid="intake-line-search" />
              </label>
              <button type="submit" className="btn btn-secondary" aria-busy={searching || undefined}>
                {searching ? r.searching : r.find}
              </button>
              {hits && hits.length > 0 ? (
                <ul className="receipt-hits">
                  {hits.map((h) => (
                    <li key={`${h.variantId}:${h.unitId ?? ""}`}>
                      <button type="button" className="receipt-hit" onClick={() => void pick(h.variantId, h.unitId)} data-testid="intake-search-hit">
                        <span className="truncate" dir="auto">
                          {pickName(locale, h)}
                          {h.matchedUnitName ? ` · ${h.matchedUnitName}` : ""}
                        </span>
                        <span className="muted" dir="ltr">
                          {h.sku}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
              {hits && hits.length === 0 ? <p className="muted">{r.noMatch}</p> : null}
            </form>
          ) : null}

          {confirmDiscard ? (
            <div className="confirm" role="group" aria-label={r.discard} data-testid="intake-discard-confirm">
              <span>{r.discardConfirm}</span>
              <div className="confirm-actions">
                <button
                  type="button"
                  className="btn btn-danger-solid"
                  aria-disabled={inert || undefined}
                  onClick={() => {
                    if (!inert) onResolve({ kind: "DISCARD" }, "discard");
                  }}
                  data-testid="intake-discard-yes"
                >
                  {r.discardYes}
                </button>
                <button ref={cancelRef} type="button" className="btn btn-secondary" onClick={() => setConfirmDiscard(false)}>
                  {r.cancel}
                </button>
              </div>
            </div>
          ) : (
            <div className="intake-line-actions">
              {choices.search ? (
                <button type="button" className="btn btn-secondary btn-small" aria-expanded={searchOpen} onClick={() => setSearchOpen((o) => !o)} data-testid="intake-line-change">
                  {searchOpen ? r.cancel : r.changeItem}
                </button>
              ) : null}
              {choices.useTotal ? (
                <button
                  type="button"
                  className="btn btn-secondary btn-small"
                  aria-disabled={inert || undefined}
                  onClick={() => !inert && onResolve({ kind: "USE_TOTAL_DIV_QTY" }, "total")}
                  data-testid="intake-line-use-total"
                >
                  {r.useTotal}
                </button>
              ) : null}
              {choices.createItem ? (
                <button type="button" className="btn btn-secondary btn-small" aria-disabled={inert || undefined} onClick={() => !inert && onCreate()} data-testid="intake-line-create">
                  {r.createItem}
                </button>
              ) : null}
              {choices.discard ? (
                <button type="button" className="btn btn-danger btn-small" aria-disabled={inert || undefined} onClick={() => !inert && setConfirmDiscard(true)} data-testid="intake-line-discard">
                  {r.discard}
                </button>
              ) : null}
              {editing ? (
                <button type="button" className="btn btn-secondary btn-small" onClick={() => setEditing(false)}>
                  {r.cancel}
                </button>
              ) : null}
            </div>
          )}
        </>
      ) : null}
    </li>
  );
}

function Printed({ label, value, note, ltr = false }: { label: string; value: string; note?: string; ltr?: boolean }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>
        <bdi dir={ltr ? "ltr" : "auto"}>{value}</bdi>
        {note ? <span className="muted"> · {note}</span> : null}
      </dd>
    </div>
  );
}
