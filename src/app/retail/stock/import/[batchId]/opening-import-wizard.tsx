"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { formatNumber, type Locale, type Messages } from "@/messages";
import { fill, formatMoney } from "../../../../_lib/format";
import { Notice } from "../../../../_ui/state";
import { useHydrated } from "../../../catalog/_lib/hydrated";
import { newKey } from "../../../catalog/_lib/keys";
import { formatQty } from "../../_lib/format";
import {
  COST_FIELD,
  lockedMapping,
  mappingProblems,
  OPENING_FIELDS,
  OPENING_ROWS_PER_PAGE,
  rowReasonText,
  type OpeningMappingDto,
  type OpeningRowDto,
  type OpeningRowStatus,
  type OpeningStatsDto,
  type OpeningSummaryDto,
} from "../../_lib/opening-import";
import { receiptFailureMessage } from "../../_lib/receipt-rules";
import type { Currency, StockFailure } from "../../_lib/types";
import { commitOpeningSliceAction, downloadOpeningRejectedAction, openingRowsAction, validateOpeningAction, type SliceDto } from "../actions";

type Batch = {
  id: string;
  fileName: string;
  status: "STAGED" | "VALIDATED" | "COMMITTED" | "FAILED";
  version: number;
  headers: string[];
  mapping: OpeningMappingDto;
  /** File columns that hold costs (locked without cost.view). */
  costColumns: number[];
  summary: OpeningSummaryDto;
  committed: OpeningStatsDto;
  rowCount: number;
  postedRows: number;
  numbers: number[];
};

type Props = {
  locale: Locale;
  t: Messages;
  currency: Currency;
  canSeeCost: boolean;
  readOnly: boolean;
  listHref: string;
  batch: Batch;
  initialRows: OpeningRowDto[];
};

type Filter = "ALL" | OpeningRowStatus;
type Busy = null | "validate" | "commit" | "download" | "rows";
type Done = Extract<SliceDto, { done: true }>;

const PREVIEW_FILTERS: Filter[] = ["ALL", "OK", "REJECTED", "SKIPPED"];
const DONE_FILTERS: Filter[] = ["ALL", "COMMITTED", "SKIPPED", "REJECTED"];
const COLUMN_MAX = 200;

/**
 * The batch whose preview heading takes focus when the wizard mounts again: a validation ends with
 * router.refresh(), which remounts the wizard (new version), so the clicked button is gone.
 */
const FOCUS_PREVIEW = "opening-import-focus-preview";

function markFocusPreview(batchId: string) {
  try {
    sessionStorage.setItem(FOCUS_PREVIEW, batchId);
  } catch {
    // Storage blocked: focus then stays where the browser leaves it.
  }
}

function takeFocusPreview(batchId: string): boolean {
  try {
    if (sessionStorage.getItem(FOCUS_PREVIEW) !== batchId) return false;
    sessionStorage.removeItem(FOCUS_PREVIEW);
    return true;
  } catch {
    return false;
  }
}

/**
 * The wizard of one opening-stock file. STAGED -> column mapping; VALIDATED -> preview, the
 * "items with stock" choice and posting (one slice of up to 500 rows per call, with progress; a
 * stop leaves the posted slices posted and "continue" posts the rest); COMMITTED -> summary and the
 * rejected rows file. Rows are read 50 at a time. Without cost.view the cost column stays where it
 * is and no other field may take a cost column (the server enforces the same).
 */
export function OpeningImportWizard({ locale, t, currency, canSeeCost, readOnly, listHref, batch, initialRows }: Props) {
  const ti = t.stock.openingImport;
  const router = useRouter();
  const hydrated = useHydrated();
  const uid = useId();

  const [mapping, setMapping] = useState<OpeningMappingDto>(batch.mapping);
  const [mappingOpen, setMappingOpen] = useState(batch.status === "STAGED");
  const [filter, setFilter] = useState<Filter>("ALL");
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState(initialRows);
  const [rowCount, setRowCount] = useState(batch.rowCount);
  const [busy, setBusy] = useState<Busy>(null);
  const [note, setNote] = useState<{ tone: "danger" | "success"; text: string } | null>(null);
  const [includeHasStock, setIncludeHasStock] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [result, setResult] = useState<Done | null>(null);
  const [reload, setReload] = useState(0);
  const validateKey = useRef<{ payload: string; key: string } | null>(null);
  const runKey = useRef<string | null>(null);
  const first = useRef(true);
  const noteRef = useRef<HTMLDivElement>(null);
  const doneRef = useRef<HTMLHeadingElement>(null);

  const status = result ? "COMMITTED" : batch.status;
  const posted = batch.postedRows > 0;
  const canRemap = status !== "COMMITTED" && !posted;
  const working = busy !== null && busy !== "rows";
  // Controls are disabled only when they cannot be used at all; the one clicked keeps focus while
  // its work runs (aria-disabled, and the handlers ignore it while busy).
  const inert = !hydrated || readOnly;

  useEffect(() => {
    if (note?.tone === "danger") noteRef.current?.scrollIntoView({ block: "nearest" });
  }, [note]);

  // After a validation (which remounted the wizard), focus the preview's heading, never the body.
  useEffect(() => {
    if (takeFocusPreview(batch.id)) doneRef.current?.focus();
  }, [batch.id]);

  useEffect(() => {
    if (result) doneRef.current?.focus();
  }, [result]);

  // A new filter or page (or the end of posting): one page of rows (the first came with the render).
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    let live = true;
    void openingRowsAction({ batchId: batch.id, page, ...(filter === "ALL" ? {} : { status: filter }) }).then(
      (r) => {
        if (!live) return;
        setBusy((b) => (b === "rows" ? null : b));
        if (!r.ok) return setNote({ tone: "danger", text: ti.loadFailed });
        setRows(r.value.rows);
        setRowCount(r.value.rowCount);
      },
      () => {
        if (!live) return;
        setBusy((b) => (b === "rows" ? null : b));
        setNote({ tone: "danger", text: ti.loadFailed });
      },
    );
    return () => {
      live = false;
    };
  }, [batch.id, filter, page, reload, ti.loadFailed]);

  const showFailure = (f: StockFailure) => {
    if (f.code === "INVALID_INPUT" && f.details?.problems) {
      const text = f.details.problems
        .split(",")
        .map((p) => ti.problems[p as keyof typeof ti.problems] ?? "")
        .filter(Boolean)
        .join(" ");
      if (text) return setNote({ tone: "danger", text });
    }
    setNote({ tone: "danger", text: receiptFailureMessage(t, f, locale) });
  };

  const problems = mappingProblems(mapping);

  async function preview() {
    if (working) return;
    if (problems.length > 0) return setNote({ tone: "danger", text: problems.map((p) => ti.problems[p]).join(" ") });
    const payload = JSON.stringify(mapping);
    if (validateKey.current?.payload !== payload) validateKey.current = { payload, key: newKey() };
    const key = validateKey.current.key;
    setBusy("validate");
    setNote(null);
    try {
      const r = await validateOpeningAction(key, { batchId: batch.id, mapping });
      validateKey.current = null;
      if (!r.ok) return showFailure(r);
      markFocusPreview(batch.id);
      router.refresh();
    } catch {
      setNote({ tone: "danger", text: t.internalError });
    } finally {
      setBusy(null);
    }
  }

  const hasStockOpen = batch.summary.hasStock > 0 && !posted;
  const total = Math.max(0, batch.summary.ok - (hasStockOpen && !includeHasStock ? batch.summary.hasStock : 0));

  async function commit() {
    if (working) return;
    // A run is named by its key: kept after no answer (the slices replay), new after a refusal.
    runKey.current ??= newKey();
    const key = runKey.current;
    setBusy("commit");
    setNote(null);
    let done = batch.postedRows;
    setProgress({ done, total: Math.max(total, done) });
    try {
      for (let n = 1; n <= 1000; n += 1) {
        const r = await commitOpeningSliceAction(key, n, { batchId: batch.id, includeHasStock, expectedVersion: batch.version });
        if (!r.ok) {
          runKey.current = null;
          showFailure(r);
          router.refresh(); // part of the rows may be posted: show the batch as it is now
          return;
        }
        if (r.value.done) {
          runKey.current = null;
          setResult(r.value);
          setFilter("ALL");
          setPage(0);
          setReload((x) => x + 1);
          return;
        }
        done += r.value.posted;
        setProgress({ done, total: Math.max(total, done) });
      }
    } catch {
      setNote({ tone: "danger", text: t.internalError });
      router.refresh();
    } finally {
      setBusy(null);
      setProgress(null);
    }
  }

  async function download() {
    if (working) return;
    setBusy("download");
    setNote(null);
    try {
      const r = await downloadOpeningRejectedAction(batch.id);
      if (!r.ok) return showFailure(r);
      const blob = new Blob([r.value], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${baseName(batch.fileName)}-rejected.csv`;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      setNote({ tone: "danger", text: t.internalError });
    } finally {
      setBusy(null);
    }
  }

  const n = (v: number) => formatNumber(locale, v);
  const pages = Math.max(1, Math.ceil(rowCount / OPENING_ROWS_PER_PAGE));
  const cell = (row: OpeningRowDto, f: (typeof OPENING_FIELDS)[number]) => (mapping[f] === null ? "" : (row.raw[mapping[f]!] ?? "").trim());
  const filters = status === "COMMITTED" ? DONE_FILTERS : PREVIEW_FILTERS;
  const stats = result?.stats ?? batch.committed;
  const numbers = result?.numbers ?? batch.numbers;
  // The reason a row is not simply ready (HAS_STOCK shows as a flag instead; POSTED is its status).
  const reasonOf = (row: OpeningRowDto) => (row.reason === "HAS_STOCK" || row.reason === "POSTED" ? null : rowReasonText(t, row.reason));
  const header = (i: number) => {
    const h = batch.headers[i] ?? "";
    return h.trim() === "" ? `#${n(i + 1)}` : h;
  };

  return (
    <div className="import-wizard" data-testid="opening-wizard" data-status={status}>
      <div aria-live="polite" ref={noteRef} className="import-note" data-testid="opening-note">
        {note ? <Notice tone={note.tone}>{note.text}</Notice> : null}
      </div>

      {/* 1. Column mapping */}
      {canRemap ? (
        <section className="section panel" aria-labelledby={`${uid}-map`} data-testid="opening-mapping">
          <div className="section-head">
            <h2 id={`${uid}-map`}>{ti.mappingTitle}</h2>
            {batch.status !== "STAGED" ? (
              <button type="button" className="btn btn-secondary btn-small" aria-expanded={mappingOpen} onClick={() => setMappingOpen((o) => !o)} data-testid="opening-mapping-toggle">
                {ti.changeMapping}
              </button>
            ) : null}
          </div>
          {mappingOpen ? (
            <form
              className="form"
              noValidate
              onSubmit={(e) => {
                e.preventDefault();
                if (!inert && !working) void preview();
              }}
            >
              <p className="muted">{ti.mappingIntro}</p>
              {!canSeeCost && batch.costColumns.length > 0 ? <p className="hint" data-testid="opening-cost-locked">{ti.costLocked}</p> : null}
              <div className="import-map-grid">
                {OPENING_FIELDS.map((f) => {
                  const lockedField = f === COST_FIELD && !canSeeCost;
                  return (
                    <label key={f} className="field">
                      <span>{ti.columns[f]}</span>
                      <select
                        className="input"
                        value={mapping[f] === null ? "" : String(mapping[f])}
                        disabled={inert || working || lockedField}
                        onChange={(e) =>
                          setMapping((m) => lockedMapping({ ...m, [f]: e.target.value === "" ? null : Number(e.target.value) }, batch.mapping, canSeeCost, batch.costColumns))
                        }
                        data-testid={`opening-map-${f}`}
                      >
                        <option value="">{ti.notInFile}</option>
                        {batch.headers.slice(0, COLUMN_MAX).map((_, i) =>
                          // Without cost.view a cost column is offered to the cost field only.
                          !canSeeCost && f !== COST_FIELD && batch.costColumns.includes(i) ? null : (
                            <option key={i} value={String(i)}>
                              {header(i)}
                            </option>
                          ),
                        )}
                      </select>
                    </label>
                  );
                })}
              </div>
              {problems.length > 0 ? (
                <ul className="import-problems" data-testid="opening-mapping-problems">
                  {problems.map((p) => (
                    <li key={p}>{ti.problems[p]}</li>
                  ))}
                </ul>
              ) : null}
              <div className="import-actions">
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={inert}
                  aria-disabled={working || undefined}
                  aria-busy={busy === "validate" || undefined}
                  data-testid="opening-validate"
                >
                  {busy === "validate" ? ti.validating : ti.validate}
                </button>
              </div>
            </form>
          ) : null}
        </section>
      ) : null}

      {/* 2. Preview / rows */}
      {status === "VALIDATED" || status === "COMMITTED" ? (
        <section className="section" aria-labelledby={`${uid}-preview`} data-testid="opening-preview">
          <div className="section-head">
            <h2 id={`${uid}-preview`} tabIndex={-1} ref={doneRef}>
              {status === "COMMITTED" ? ti.doneTitle : ti.previewTitle}
            </h2>
          </div>
          {status === "COMMITTED" ? (
            <>
              <dl className="import-stats" data-testid="opening-done-stats">
                {(["posted", "skipped", "skippedHasStock", "rejected", "documents"] as const).map((k) => (
                  <div key={k} className="import-stat" data-testid={`opening-stat-${k}`} data-tone={k === "rejected" && stats[k] > 0 ? "danger" : undefined}>
                    <dt>{ti.stats[k]}</dt>
                    <dd>{n(stats[k])}</dd>
                  </div>
                ))}
              </dl>
              {numbers.length > 0 ? <p data-testid="opening-done-numbers">{fill(ti.documents, { numbers: numbers.map(n).join("، ") })}</p> : null}
              {result?.valueMinor !== undefined ? (
                <p data-testid="opening-done-value">{fill(ti.value, { amount: formatMoney(locale, currency, result.valueMinor, t.catalog.currencyShort[currency]) })}</p>
              ) : null}
            </>
          ) : (
            <dl className="import-stats" data-testid="opening-summary">
              {(["total", "ok", "hasStock", "rejected", "skipped", "expired", "costMissing"] as const)
                .filter((k) => canSeeCost || k !== "costMissing")
                .map((k) => (
                  <div
                    key={k}
                    className="import-stat"
                    data-testid={`opening-count-${k}`}
                    data-tone={k === "rejected" && batch.summary[k] > 0 ? "danger" : (k === "hasStock" || k === "expired") && batch.summary[k] > 0 ? "warn" : undefined}
                  >
                    <dt>{ti.summary[k]}</dt>
                    <dd>{n(batch.summary[k])}</dd>
                  </div>
                ))}
            </dl>
          )}

          <div className="import-tabs" role="group" aria-label={ti.filterLabel}>
            {filters.map((f) => (
              <button
                key={f}
                type="button"
                className="btn btn-secondary btn-small"
                aria-pressed={filter === f}
                onClick={() => {
                  setFilter(f);
                  setPage(0);
                  setBusy((b) => b ?? "rows");
                }}
                data-testid={`opening-filter-${f}`}
              >
                {f === "ALL" ? ti.filterAll : ti.rowStatus[f]}
              </button>
            ))}
          </div>

          {rows.length === 0 ? (
            <p className="muted" data-testid="opening-no-rows">
              {busy === "rows" ? ti.loading : ti.noRows}
            </p>
          ) : (
            <table className="data-table import-rows" aria-busy={busy === "rows" || undefined}>
              <thead>
                <tr>
                  <th scope="col">{ti.colItem}</th>
                  <th scope="col">{ti.colRow}</th>
                  <th scope="col">{ti.colQty}</th>
                  <th scope="col">{ti.colStatusRow}</th>
                  <th scope="col">{ti.colDetails}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const code = cell(row, "barcode") || cell(row, "sku");
                  const unit = cell(row, "unit");
                  const flags = row.flags.filter((f) => canSeeCost || f !== "COST_MISSING");
                  return (
                    <tr key={row.rowNumber} data-testid="opening-row" data-status={row.status} data-row={row.rowNumber}>
                      <td>
                        <span className="import-row-code" dir="ltr">
                          {code || "—"}
                        </span>
                      </td>
                      <td data-secondary className="import-row-num">
                        <span className="visually-hidden">{ti.colRow} </span>
                        {n(row.rowNumber)}
                      </td>
                      <td>
                        <span dir="auto">
                          {cell(row, "quantity") || "—"}
                          {unit ? ` ${unit}` : ""}
                        </span>
                      </td>
                      <td>
                        <span className="badge" data-tone={statusTone(row.status)} data-testid="opening-row-status">
                          {ti.rowStatus[row.status]}
                        </span>
                      </td>
                      <td className="import-row-details" data-testid="opening-row-details">
                        {reasonOf(row) ? (
                          <span className={row.status === "REJECTED" ? "import-reason import-reason-danger" : "import-reason"} data-testid="opening-row-reason">
                            {reasonOf(row)}
                          </span>
                        ) : null}
                        {flags.length > 0 ? (
                          <span className="opening-flags">
                            {flags.map((f) => (
                              <span key={f} className="badge" data-tone="warn">
                                {ti.flags[f]}
                              </span>
                            ))}
                          </span>
                        ) : null}
                        {row.onHand !== null ? (
                          <span className="import-reason" data-testid="opening-row-on-hand">
                            {fill(ti.onHand, { qty: formatQty(locale, row.onHand) })}
                          </span>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}

          {pages > 1 ? (
            <nav className="import-pager" aria-label={fill(ti.page, { page: n(page + 1), pages: n(pages) })}>
              <button
                type="button"
                className="btn btn-secondary btn-small"
                onClick={() => {
                  setPage((p) => Math.max(0, p - 1));
                  setBusy((b) => b ?? "rows");
                }}
                disabled={page === 0 || busy === "rows"}
              >
                {ti.prev}
              </button>
              <span className="muted" aria-live="polite">
                {fill(ti.page, { page: n(page + 1), pages: n(pages) })}
              </span>
              <button
                type="button"
                className="btn btn-secondary btn-small"
                onClick={() => {
                  setPage((p) => Math.min(pages - 1, p + 1));
                  setBusy((b) => b ?? "rows");
                }}
                disabled={page >= pages - 1 || busy === "rows"}
              >
                {ti.next}
              </button>
            </nav>
          ) : null}
        </section>
      ) : null}

      {/* 3. Items with stock, and posting */}
      {status === "VALIDATED" ? (
        <section className="section panel import-confirm" aria-labelledby={`${uid}-post`} data-testid="opening-confirm">
          <h2 id={`${uid}-post`}>{ti.confirmTitle}</h2>
          {posted ? (
            <Notice tone="danger">
              <span data-testid="opening-partial">{fill(ti.partial, { count: n(batch.postedRows) })}</span>
            </Notice>
          ) : null}
          {hasStockOpen ? (
            <fieldset className="fieldset" data-testid="opening-has-stock">
              <legend>{ti.hasStockTitle}</legend>
              <p>{fill(ti.hasStockBody, { count: n(batch.summary.hasStock) })}</p>
              <label className="check">
                <input type="checkbox" checked={includeHasStock} onChange={(e) => setIncludeHasStock(e.target.checked)} disabled={inert || working} data-testid="opening-include-has-stock" />
                {ti.includeHasStock}
              </label>
              {!includeHasStock ? <span className="hint">{ti.hasStockSkipped}</span> : null}
            </fieldset>
          ) : null}
          <p data-testid="opening-confirm-body">{fill(ti.confirmBody, { ok: n(total), rejected: n(batch.summary.rejected) })}</p>
          <div className="import-actions">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void commit()}
              disabled={inert}
              aria-disabled={working || undefined}
              aria-busy={busy === "commit" || undefined}
              data-testid="opening-commit"
            >
              {posted ? ti.resume : ti.commit}
            </button>
            {progress ? (
              <span className="muted" role="status" data-testid="opening-committing">
                {fill(ti.committing, { done: n(progress.done), total: n(progress.total) })}
              </span>
            ) : null}
          </div>
          {progress ? <progress className="opening-progress" max={Math.max(1, progress.total)} value={progress.done} aria-label={ti.commit} /> : null}
        </section>
      ) : null}

      {/* 4. After posting */}
      {status === "COMMITTED" ? (
        <section className="section panel" data-testid="opening-done">
          {stats.rejected > 0 ? <p className="muted">{ti.downloadHint}</p> : null}
          <div className="import-actions">
            {stats.rejected > 0 ? (
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  if (!working) void download();
                }}
                disabled={inert}
                aria-disabled={working || undefined}
                aria-busy={busy === "download" || undefined}
                data-testid="opening-download-rejected"
              >
                {ti.downloadRejected}
              </button>
            ) : null}
            <Link href="/retail/stock" className={stats.rejected > 0 ? "btn btn-secondary" : "btn btn-primary"}>
              {ti.openStock}
            </Link>
            <Link href={listHref} className="btn btn-secondary">
              {ti.newImport}
            </Link>
          </div>
        </section>
      ) : null}
    </div>
  );
}

function statusTone(status: OpeningRowStatus): "accent" | "danger" | undefined {
  if (status === "OK" || status === "COMMITTED") return "accent";
  if (status === "REJECTED") return "danger";
  return undefined;
}

function baseName(name: string): string {
  return name.replace(/\.[^.]*$/, "").replace(/[\\/:*?"<>|]+/g, "_").slice(0, 80) || "import";
}
