"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import type { Locale, Messages } from "@/messages";
import { fill, pickName } from "../../../_lib/format";
import { Notice } from "../../../_ui/state";
import { useHydrated } from "../../catalog/_lib/hydrated";
import { newKey } from "../../catalog/_lib/keys";
import {
  addScanned,
  blockedReason,
  draftPayload,
  firstUnpostable,
  firstUnsavable,
  hasHiddenCosts,
  isSaveBlocking,
  lineIssues,
  MAX_LINES,
  nextAttempt,
  RECEIPT_KINDS,
  receiveHref,
  receiptFailureMessage,
  restoreLines,
  scanUnit,
  SingleFlight,
  withCurrency,
  type DocumentDto,
  type ItemInfo,
  type ReceiptKind,
  type ReceiptLine,
  type ReceiptSettings,
} from "../_lib/receipt-rules";
import { HiddenCostNotice, LineFields, LinesEmpty, PostBar, ReceiptDone, SaveStatusText, type LineField, type ReceiptDoneDto, type SaveState } from "../_lib/receipt-views";
import type { Currency, StockFailure } from "../_lib/types";
import { discardReceiptAction, postedSummaryAction, postReceiptAction, receiveItemAction, receiveSearchAction, saveReceiptDraftAction, type ReceiveHit } from "./actions";

type Props = {
  locale: Locale;
  t: Messages;
  settings: ReceiptSettings;
  /** The business's day (YYYY-MM-DD): a past expiry is refused for a receipt, noted for opening stock. */
  today: string;
  /** The business accepts no writes now: the form is shown, nothing can be saved or posted. */
  readOnly: boolean;
  kind: ReceiptKind;
  /** A saved draft reopened by its link (?draft=id), with every item its lines name. */
  initial: { doc: DocumentDto; items: Record<string, ItemInfo> } | null;
  /** Extra query kept on the links this screen writes ("from=setup", or ""). */
  query: string;
};

const SAVE_DELAY_MS = 800;

type Saved = { documentId: string | null; version: number | null; payload: string | null };

/**
 * A receipt or opening-stock document. Scanning adds a line (the same item again raises its
 * quantity); the draft saves itself on the server a moment after each change (whole, version-
 * checked), so a reload reopens it from its link. One save and one post at a time; a post first
 * saves what is on screen, and its key is kept while the same version is retried after a lost answer.
 */
export function ReceiptForm({ locale, t, settings, today, readOnly, kind: initialKind, initial, query }: Props) {
  const r = t.stock.receive;
  const router = useRouter();
  const hydrated = useHydrated();
  const uid = useId();

  // Keys of restored lines are the same on the server and in the browser (hydration); new lines get random ones.
  const [restored] = useState(() => {
    let n = 0;
    return initial ? restoreLines(initial.doc, initial.items, settings, () => `saved-${(n += 1)}`) : null;
  });
  const [kind, setKind] = useState<ReceiptKind>(initial && (initial.doc.kind === "RECEIPT" || initial.doc.kind === "OPENING") ? initial.doc.kind : initialKind);
  const [supplier, setSupplier] = useState(initial?.doc.supplierRef ?? "");
  const [note, setNote] = useState(initial?.doc.note ?? "");
  const [lines, setLines] = useState<ReceiptLine[]>(restored ?? []);
  const [documentId, setDocumentId] = useState<string | null>(initial?.doc.id ?? null);
  const [rev, setRev] = useState(0);
  const [saveState, setSaveState] = useState<SaveState>({ kind: initial ? "saved" : "idle" });
  const [conflict, setConflict] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [posting, setPosting] = useState(false);
  const [failure, setFailure] = useState<StockFailure | null>(null);
  const [done, setDone] = useState<{ value: ReceiptDoneDto; again: boolean } | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [announce, setAnnounce] = useState("");
  const [search, setSearch] = useState("");
  const [hits, setHits] = useState<ReceiveHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [checkRun, setCheckRun] = useState(0);

  // A draft whose costs this role cannot see is never saved from here (a save replaces every line).
  const hidden = hasHiddenCosts(lines);
  const locked = readOnly || hidden || conflict || done !== null;

  // What is on screen, for the save and post handlers (which run after the render that drew it).
  const latest = useRef({ kind, supplier, note, lines });
  useLayoutEffect(() => {
    latest.current = { kind, supplier, note, lines };
  });
  const saved = useRef<Saved>({
    documentId: initial?.doc.id ?? null,
    version: initial?.doc.version ?? null,
    payload: restored && initial ? JSON.stringify(draftPayload(initial.doc.kind === "OPENING" ? "OPENING" : "RECEIPT", initial.doc.supplierRef ?? "", initial.doc.note ?? "", restored, settings)) : null,
  });
  const saveAttempt = useRef<{ payload: string; key: string } | null>(null);
  const postAttempt = useRef<{ payload: string; key: string } | null>(null);
  const saving = useRef<Promise<boolean> | null>(null);
  const flight = useRef(new SingleFlight());
  const scans = useRef<Promise<void>>(Promise.resolve());
  const stopped = useRef(false);
  const scanRef = useRef<HTMLInputElement>(null);
  const linesRef = useRef<HTMLOListElement>(null);
  const doneRef = useRef<HTMLHeadingElement>(null);

  /** A change to save: the save state says so at once, the save itself follows a moment later. */
  const touch = useCallback(() => {
    setRev((n) => n + 1);
    setSaveState({ kind: "pending" });
  }, []);

  const edit = useCallback(
    (next: (l: ReceiptLine[]) => ReceiptLine[]) => {
      setLines(next);
      touch();
    },
    [touch],
  );

  /** Saves what is on screen now (waits for a save on its way first). True when the server holds it. */
  const saveNow = useCallback(async (): Promise<boolean> => {
    while (saving.current) await saving.current;
    const st = latest.current;
    if (stopped.current || hasHiddenCosts(st.lines)) return false;
    if (st.lines.length === 0 && saved.current.documentId === null) {
      setSaveState({ kind: "idle" });
      return true;
    }
    const bad = firstUnsavable(st.lines, st.kind, settings, today);
    if (bad !== null) {
      setSaveState({ kind: "blocked", line: bad });
      return false;
    }
    const payload = draftPayload(st.kind, st.supplier, st.note, st.lines, settings);
    const text = JSON.stringify(payload);
    if (text === saved.current.payload) {
      setSaveState({ kind: "saved" });
      return true;
    }
    const { documentId: id, version } = saved.current;
    // The same body sent again (after no answer) keeps its key: the server replays, never saves twice.
    const attempt = nextAttempt(saveAttempt.current, `${id}:${version}:${text}`, newKey);
    saveAttempt.current = attempt;
    setSaveState({ kind: "saving" });
    const run = (async () => {
      try {
        const res = await saveReceiptDraftAction(attempt.key, { ...payload, ...(id && version ? { documentId: id, expectedVersion: version } : {}) });
        saveAttempt.current = null;
        if (res.ok) {
          saved.current = { documentId: res.value.documentId, version: res.value.version, payload: text };
          if (id === null) {
            setDocumentId(res.value.documentId);
            // The link now opens this draft (a reload reopens it).
            window.history.replaceState(null, "", receiveHref({ draft: res.value.documentId }, query));
          }
          setSaveState({ kind: JSON.stringify(draftPayload(latest.current.kind, latest.current.supplier, latest.current.note, latest.current.lines, settings)) === text ? "saved" : "pending" });
          return true;
        }
        if (res.code === "VERSION_CONFLICT" || res.code === "DOCUMENT_POSTED" || res.code === "NOT_FOUND") {
          stopped.current = true;
          setConflict(true);
          return false;
        }
        setSaveState({ kind: "failed", failure: res });
        return false;
      } catch {
        setSaveState({ kind: "offline" });
        return false;
      }
    })();
    saving.current = run;
    try {
      return await run;
    } finally {
      saving.current = null;
    }
  }, [query, settings, today]);

  // A moment after each change, save the draft (one timer; a newer change restarts it).
  useEffect(() => {
    if (rev === 0 || locked) return;
    const timer = setTimeout(() => void saveNow(), SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [rev, locked, saveNow]);

  // After a refused post, take the user to the first field to fix.
  useEffect(() => {
    if (checkRun > 0) linesRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [checkRun]);

  // After posting, focus the summary's title (never the body).
  useEffect(() => {
    if (done) doneRef.current?.focus();
  }, [done]);

  // ------------------------------------------------------------------------------------------
  // Adding items

  async function addHit(hit: ReceiveHit) {
    const name = pickName(locale, hit);
    if (latest.current.lines.length >= MAX_LINES) return setAnnounce(r.tooManyLines);
    const read = await receiveItemAction({ productId: hit.productId, variantId: hit.variantId });
    if (!read.ok) return setAnnounce(receiptFailureMessage(t, read, locale));
    const item = read.value;
    const blocked = blockedReason(item);
    if (blocked) return setAnnounce(fill(r.blocked[blocked], { name }));
    const result = addScanned(latest.current.lines, item, scanUnit(item, hit.unitId), settings, newKey());
    latest.current = { ...latest.current, lines: result.lines };
    edit(() => result.lines);
    const line = result.lines.find((l) => l.key === result.key)!;
    setAnnounce(result.bumped ? fill(r.bumped, { name, qty: line.quantity }) : fill(r.added, { name }));
  }

  async function lookUp(text: string) {
    setSearching(true);
    try {
      const res = await receiveSearchAction(text);
      if (!res.ok) {
        setAnnounce(r.searchFailed);
        return;
      }
      const list = res.value;
      // A scanned barcode (or a single match) adds at once; several matches are offered to pick from.
      const exact = list.find((h) => h.matchedBarcode !== undefined && h.matchedBarcode === text.trim());
      const pick = exact ?? (list.length === 1 ? list[0] : undefined);
      if (pick) {
        setHits(null);
        setSearch("");
        await addHit(pick);
        return;
      }
      setHits(list);
      if (list.length === 0) setAnnounce(r.noMatch);
    } catch {
      setAnnounce(r.searchFailed);
    } finally {
      setSearching(false);
    }
  }

  // Scans are handled one after another, in the order they were made (a fast scanner never loses one).
  const enqueue = (task: () => Promise<void>) => {
    scans.current = scans.current.then(task, task);
  };

  const onScan = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = search.trim();
    if (text === "" || locked) return;
    setSearch("");
    enqueue(() => lookUp(text));
  };

  const pickHit = (hit: ReceiveHit) => {
    setHits(null);
    setSearch("");
    enqueue(() => addHit(hit));
    scanRef.current?.focus();
  };

  // ------------------------------------------------------------------------------------------
  // Lines

  const change = (key: string, field: LineField, value: string) =>
    edit((list) =>
      list.map((l) => {
        if (l.key !== key) return l;
        if (field === "currency") return withCurrency(l, value as Currency, list, settings);
        return { ...l, [field]: value };
      }),
    );

  const remove = (key: string) => {
    edit((list) => list.filter((l) => l.key !== key));
    scanRef.current?.focus();
  };

  const changeKind = (next: ReceiptKind) => {
    setKind(next);
    touch();
    if (saved.current.documentId === null) {
      window.history.replaceState(null, "", receiveHref({ kind: next }, query));
    }
  };

  // ------------------------------------------------------------------------------------------
  // Post and delete

  async function post() {
    await flight.current.run(async () => {
      setFailure(null);
      const st = latest.current;
      if (st.lines.length === 0) {
        setFailure({ code: "STOCK_RULE", details: { reason: "EMPTY" } });
        scanRef.current?.focus();
        return;
      }
      if (firstUnpostable(st.lines, st.kind, settings, today) !== null) {
        setShowAll(true);
        setCheckRun((n) => n + 1);
        return;
      }
      setPosting(true);
      try {
        if (!hasHiddenCosts(st.lines) && !(await saveNow())) return;
        const { documentId: id, version } = saved.current;
        if (!id || !version) return;
        postAttempt.current = nextAttempt(postAttempt.current, `${id}:${version}`, newKey);
        const res = await postReceiptAction(postAttempt.current.key, { documentId: id, expectedVersion: version });
        postAttempt.current = null;
        if (res.ok) {
          stopped.current = true;
          setDone({ value: res.value, again: false });
          return;
        }
        if (res.code === "DOCUMENT_POSTED") {
          const summary = await postedSummaryAction(id);
          if (summary.ok) {
            stopped.current = true;
            setDone({ value: summary.value, again: true });
            return;
          }
        }
        if (res.code === "VERSION_CONFLICT") {
          stopped.current = true;
          setConflict(true);
        }
        if (res.details?.lineNo) setShowAll(true);
        setFailure(res);
      } catch {
        // No answer: the key is kept, so posting again replays instead of posting twice.
        setFailure({ code: "INTERNAL" });
      } finally {
        setPosting(false);
      }
    });
  }

  async function discard() {
    const { documentId: id, version } = saved.current;
    if (!id || !version || discarding) return;
    setDiscarding(true);
    setFailure(null);
    try {
      while (saving.current) await saving.current;
      const res = await discardReceiptAction(newKey(), { documentId: id, expectedVersion: saved.current.version ?? version });
      if (!res.ok) {
        if (res.code === "VERSION_CONFLICT") setConflict(true);
        setFailure(res);
        return;
      }
      saved.current = { documentId: null, version: null, payload: null };
      stopped.current = false;
      setDocumentId(null);
      setLines([]);
      setSupplier("");
      setNote("");
      setSaveState({ kind: "idle" });
      setShowAll(false);
      setConfirmDiscard(false);
      setAnnounce(r.discarded);
      window.history.replaceState(null, "", receiveHref({ kind }, query));
      scanRef.current?.focus();
    } catch {
      setFailure({ code: "INTERNAL" });
    } finally {
      setDiscarding(false);
    }
  }

  // ------------------------------------------------------------------------------------------

  if (done) {
    return (
      <ReceiptDone
        locale={locale}
        t={t}
        currency={settings.defaultCurrency}
        done={done.value}
        headingRef={doneRef}
        alreadyPosted={done.again}
        newHref={receiveHref({ kind: done.value.kind }, query)}
      />
    );
  }

  const issues = lines.map((l) => lineIssues(l, kind, settings, today));
  const blockedPost = issues.some((i) => i.problems.length > 0);
  const inert = !hydrated || locked || posting;

  return (
    <div className="receipt" data-testid="receipt-form" data-kind={kind}>
      <div aria-live="polite" className="visually-hidden" data-testid="receipt-announce">
        {announce}
      </div>
      {hidden ? <HiddenCostNotice t={t} /> : null}
      {conflict ? (
        <div className="section product-note" data-testid="receipt-conflict">
          <Notice tone="danger">{r.conflict}</Notice>
          <div>
            <button type="button" className="btn btn-secondary" onClick={() => router.refresh()}>
              {r.reload}
            </button>
          </div>
        </div>
      ) : null}

      <section className="section panel receipt-head" aria-label={r.kind}>
        <fieldset className="fieldset" disabled={!hydrated || locked || posting || documentId !== null}>
          <legend>{r.kind}</legend>
          <div className="stock-modes" data-testid="receipt-kind">
            {RECEIPT_KINDS.map((k) => (
              <label key={k} className="check stock-mode">
                <input type="radio" name={`${uid}-kind`} value={k} checked={kind === k} onChange={() => changeKind(k)} />
                {r.kinds[k]}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="field-row">
          {kind === "RECEIPT" ? (
            <label className="field">
              <span>{r.supplier}</span>
              <input
                className="input"
                dir="auto"
                maxLength={200}
                value={supplier}
                disabled={inert}
                onChange={(e) => {
                  setSupplier(e.target.value);
                  touch();
                }}
                aria-describedby={`${uid}-supplier-hint`}
                data-testid="receipt-supplier"
              />
              <span className="hint" id={`${uid}-supplier-hint`}>
                {r.supplierHint}
              </span>
            </label>
          ) : null}
          <label className="field">
            <span>{r.note}</span>
            <input
              className="input"
              dir="auto"
              maxLength={1000}
              value={note}
              disabled={inert}
              onChange={(e) => {
                setNote(e.target.value);
                touch();
              }}
              data-testid="receipt-note"
            />
          </label>
        </div>
      </section>

      <section className="section receipt-scan" aria-labelledby={`${uid}-scan`}>
        <form className="receipt-scan-form" onSubmit={onScan} role="search">
          <label className="field">
            <span id={`${uid}-scan`}>{r.scan}</span>
            <input
              ref={scanRef}
              className="input"
              type="search"
              dir="auto"
              autoComplete="off"
              enterKeyHint="enter"
              maxLength={100}
              placeholder={r.scanPlaceholder}
              value={search}
              disabled={!hydrated || locked}
              onChange={(e) => setSearch(e.target.value)}
              aria-describedby={`${uid}-scan-hint`}
              data-testid="receipt-scan"
            />
            <span className="hint" id={`${uid}-scan-hint`}>
              {r.scanHint}
            </span>
          </label>
          <button type="submit" className="btn btn-secondary" disabled={!hydrated || locked} aria-busy={searching || undefined} data-testid="receipt-scan-submit">
            {searching ? r.searching : r.add}
          </button>
        </form>
        {hits && hits.length > 0 ? (
          <ul className="receipt-hits" aria-label={r.results} data-testid="receipt-hits">
            {hits.map((h) => (
              <li key={`${h.variantId}:${h.unitId ?? ""}`}>
                <button type="button" className="receipt-hit" onClick={() => pickHit(h)} data-testid="receipt-hit">
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
        {hits && hits.length === 0 ? (
          <p className="muted" data-testid="receipt-no-match">
            {r.noMatch}
          </p>
        ) : null}
      </section>

      <section className="section" aria-labelledby={`${uid}-lines`}>
        <div className="section-head">
          <h2 id={`${uid}-lines`}>{fill(r.lineCount, { count: lines.length })}</h2>
          {!hidden && !readOnly ? <SaveStatusText locale={locale} t={t} state={saveState} /> : null}
        </div>
        {saveState.kind === "failed" || saveState.kind === "offline" ? (
          <div>
            <button type="button" className="btn btn-secondary btn-small" onClick={() => void saveNow()} disabled={inert} data-testid="receipt-retry-save">
              {r.retrySave}
            </button>
          </div>
        ) : null}
        {lines.length === 0 ? (
          <LinesEmpty t={t} />
        ) : (
          <ol className="receipt-lines" ref={linesRef}>
            {lines.map((l, i) => {
              const { problems, warnings } = issues[i]!;
              const shown = showAll ? problems : problems.filter((p) => isSaveBlocking(p) && p !== "QUANTITY_REQUIRED");
              return (
                <LineFields
                  key={l.key}
                  locale={locale}
                  t={t}
                  line={l}
                  index={i}
                  kind={kind}
                  settings={settings}
                  problems={shown}
                  warnings={warnings}
                  disabled={inert}
                  onChange={(field, value) => change(l.key, field, value)}
                  onRemove={() => remove(l.key)}
                />
              );
            })}
          </ol>
        )}
      </section>

      {failure ? (
        <div className="section" data-testid="receipt-failure">
          <Notice tone="danger">{receiptFailureMessage(t, failure, locale)}</Notice>
        </div>
      ) : null}

      <section className="section panel">
        {confirmDiscard ? (
          <div className="confirm" role="group" aria-label={r.discard}>
            <span>{r.discardConfirm}</span>
            <div className="confirm-actions">
              <button type="button" className="btn btn-danger-solid" onClick={() => void discard()} disabled={!hydrated || readOnly || posting} aria-busy={discarding || undefined} data-testid="receipt-discard-yes">
                {r.discardYes}
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => setConfirmDiscard(false)} disabled={discarding}>
                {r.cancel}
              </button>
            </div>
          </div>
        ) : (
          <PostBar
            t={t}
            posting={posting}
            blocked={showAll && blockedPost}
            canDiscard={documentId !== null}
            disabled={!hydrated || readOnly || conflict}
            onPost={() => void post()}
            onDiscard={() => setConfirmDiscard(true)}
          />
        )}
      </section>
    </div>
  );
}
