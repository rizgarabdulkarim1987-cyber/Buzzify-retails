"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { dirOf, formatNumber, type Locale, type Messages } from "@/messages";
import { KNOWN_COLUMNS, validateMapping, type KnownColumn } from "@/server/catalog/import/mapping";
import { fill, formatMoney } from "../../../../_lib/format";
import { Notice } from "../../../../_ui/state";
import { failureMessage } from "../../_lib/failures";
import { useHydrated } from "../../_lib/hydrated";
import { newKey } from "../../_lib/keys";
import type { UiFailure } from "../../_lib/types";
import { commitImportAction, deleteBatchAction, downloadRejectedAction, loadRowsAction, savePresetAction, validateImportAction } from "../actions";
import { ROWS_PER_PAGE, type BatchStats, type Choice, type ImportRowDto, type MappingDto, type PresetDto, type RowStatusDto } from "../_lib/types";

type Batch = {
  id: string;
  fileName: string;
  status: "STAGED" | "VALIDATED" | "COMMITTED" | "FAILED";
  version: number;
  isTestData: boolean;
  headers: string[];
  mapping: MappingDto;
  stats: BatchStats;
  committedRows: number;
  rowCount: number;
};

type Props = {
  locale: Locale;
  t: Messages;
  batch: Batch;
  initialRows: ImportRowDto[];
  presets: PresetDto[];
  sameFile: boolean;
};

type Filter = "ALL" | RowStatusDto;
type Busy = null | "validate" | "commit" | "preset" | "delete" | "download" | "rows";
type Note = { tone: "danger" | "success"; text: string } | null;

const PREVIEW_FILTERS: Filter[] = ["ALL", "OK", "CHANGED", "SKIPPED", "REJECTED"];
const DONE_FILTERS: Filter[] = ["ALL", "COMMITTED", "SKIPPED", "REJECTED"];
const COLUMN_MAX = 200;

/**
 * The import wizard of one batch. The batch's status decides what shows: STAGED -> column mapping;
 * VALIDATED -> preview, decisions for changed rows and save (with "continue" when a save stopped
 * partway); COMMITTED -> summary and the rejected rows file. Rows are read one page (50) at a time,
 * so a 10,000-row file never lands in the page at once. Every step that changes the batch ends
 * with router.refresh(): the server page renders the new state.
 */
export function ImportWizard({ locale, t, batch, initialRows, presets: initialPresets, sameFile }: Props) {
  const ti = t.catalog.import;
  const router = useRouter();
  const hydrated = useHydrated();
  const uid = useId();
  const committedAny = batch.committedRows > 0;
  const canRemap = batch.status !== "COMMITTED" && !committedAny;

  const [mapping, setMapping] = useState<MappingDto>(batch.mapping);
  const [mappingOpen, setMappingOpen] = useState(batch.status === "STAGED");
  const [presets, setPresets] = useState(initialPresets);
  const [presetId, setPresetId] = useState("");
  const [presetName, setPresetName] = useState("");
  const [filter, setFilter] = useState<Filter>("ALL");
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<ImportRowDto[]>(initialRows);
  const [rowCount, setRowCount] = useState(batch.rowCount);
  const [choice, setChoice] = useState<Choice>("SKIP");
  const [overrides, setOverrides] = useState<Record<number, Choice>>({});
  const [busy, setBusy] = useState<Busy>(null);
  const [note, setNote] = useState<Note>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const keys = useRef({ validate: newKey(), commit: newKey(), preset: newKey(), remove: newKey() });
  const first = useRef(true);
  const noteRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (note?.tone === "danger") noteRef.current?.scrollIntoView({ block: "nearest" });
  }, [note]);

  // A new filter or page: one page of rows from the server (the first page came with the render).
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    let live = true;
    setBusy((b) => b ?? "rows");
    void loadRowsAction({ batchId: batch.id, page, ...(filter === "ALL" ? {} : { status: filter }) }).then(
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
  }, [batch.id, filter, page, ti.loadFailed]);

  const fail = (f: UiFailure) => {
    if (f.code === "INVALID_INPUT" && f.details?.problems) {
      const text = f.details.problems
        .split(",")
        .map((p) => ti.problems[p as keyof typeof ti.problems] ?? "")
        .filter(Boolean)
        .join(" ");
      return setNote({ tone: "danger", text: text || failureMessage(t, f) });
    }
    setNote({ tone: "danger", text: failureMessage(t, f) });
  };

  async function run<T>(kind: Exclude<Busy, null | "rows">, task: () => Promise<T>): Promise<T | null> {
    setBusy(kind);
    setNote(null);
    try {
      return await task();
    } catch {
      setNote({ tone: "danger", text: t.internalError });
      return null;
    } finally {
      setBusy(null);
    }
  }

  const check = validateMapping(mapping);
  const problems = check.problems.map((p) => ti.problems[p]);

  async function preview() {
    if (!check.ok) return setNote({ tone: "danger", text: problems.join(" ") });
    const r = await run("validate", () => validateImportAction(keys.current.validate, { batchId: batch.id, mapping }));
    keys.current.validate = newKey();
    if (!r) return;
    if (!r.ok) return fail(r);
    router.refresh();
  }

  async function savePreset() {
    const name = presetName.trim();
    if (name === "") return;
    const r = await run("preset", () => savePresetAction(keys.current.preset, { name, mapping }));
    keys.current.preset = newKey();
    if (!r) return;
    if (!r.ok) return fail(r);
    setPresets((list) => [...list.filter((p) => p.id !== r.value.id), r.value].sort((a, b) => a.name.localeCompare(b.name, locale)));
    setPresetName("");
    setNote({ tone: "success", text: ti.presetSaved });
  }

  function applyPreset() {
    const p = presets.find((x) => x.id === presetId);
    if (!p) return;
    setMapping(p.mapping);
    setNote({ tone: "success", text: ti.presetApplied });
  }

  async function commit() {
    const r = await run("commit", () =>
      commitImportAction(keys.current.commit, { batchId: batch.id, expectedVersion: batch.version, choice, overrides }),
    );
    if (!r) return router.refresh();
    if (!r.ok) {
      keys.current.commit = newKey();
      fail(r);
      // Part of the rows may be in the catalog already: show the batch as it is now.
      return router.refresh();
    }
    router.refresh();
  }

  async function download() {
    const r = await run("download", () => downloadRejectedAction(batch.id));
    if (!r) return;
    if (!r.ok) return fail(r);
    const blob = new Blob([r.value], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${baseName(batch.fileName)}-rejected.csv`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function remove() {
    const r = await run("delete", () => deleteBatchAction(keys.current.remove, batch.id));
    keys.current.remove = newKey();
    if (!r) return;
    if (!r.ok) return fail(r);
    router.push("/retail/catalog/import");
  }

  const s = batch.stats;
  const n = (v: number | undefined) => formatNumber(locale, v ?? 0);
  const pages = Math.max(1, Math.ceil(rowCount / ROWS_PER_PAGE));
  const updateCount = (() => {
    const changed = s.changed ?? 0;
    const flipped = Object.values(overrides).length;
    return choice === "UPDATE" ? changed - flipped : flipped;
  })();
  const cell = (row: ImportRowDto, col: KnownColumn) => (mapping[col] === null ? "" : (row.raw[mapping[col]!] ?? "").trim());
  const filters = batch.status === "COMMITTED" ? DONE_FILTERS : PREVIEW_FILTERS;
  const working = busy !== null && busy !== "rows";

  const shown = (d: { field: string; before: string | null; after: string }, v: string | null) => {
    if (v === null || v === "") return "—";
    if (d.field.startsWith("price.")) {
      const cur = d.field.slice(6) === "USD" ? "USD" : "IQD";
      try {
        return formatMoney(locale, cur, v, t.catalog.currencyShort[cur]);
      } catch {
        return v;
      }
    }
    return v;
  };
  const fieldLabel = (field: string) =>
    field.startsWith("price.") ? `${ti.fields.price} (${t.catalog.currencyShort[field.slice(6) === "USD" ? "USD" : "IQD"]})` : (ti.fields[field as keyof typeof ti.fields] ?? field);

  return (
    <div className="import-wizard" data-testid="import-wizard" data-status={batch.status}>
      <div aria-live="polite" ref={noteRef} className="import-note" data-testid="import-note">
        {note ? <Notice tone={note.tone}>{note.text}</Notice> : null}
      </div>
      {sameFile && batch.status !== "COMMITTED" ? <Notice tone="success">{ti.sameFile}</Notice> : null}
      {batch.isTestData ? (
        <p>
          <span className="badge" data-tone="warn">
            {ti.trialBadge}
          </span>
        </p>
      ) : null}

      {/* 1. Column mapping */}
      {canRemap ? (
        <section className="section panel" aria-labelledby={`${uid}-map`} data-testid="import-mapping">
          <div className="section-head">
            <h2 id={`${uid}-map`}>{ti.mappingTitle}</h2>
            {batch.status !== "STAGED" ? (
              <button type="button" className="btn btn-secondary btn-small" aria-expanded={mappingOpen} onClick={() => setMappingOpen((o) => !o)} data-testid="import-mapping-toggle">
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
                if (!working) void preview();
              }}
            >
              <p className="muted">{ti.mappingIntro}</p>
              <div className="import-map-grid">
                {KNOWN_COLUMNS.map((col) => (
                  <label key={col} className="field">
                    <span>{ti.columns[col]}</span>
                    <select
                      className="input"
                      value={mapping[col] === null ? "" : String(mapping[col])}
                      disabled={!hydrated || working}
                      onChange={(e) => setMapping((m) => ({ ...m, [col]: e.target.value === "" ? null : Number(e.target.value) }))}
                      data-testid={`import-map-${col}`}
                    >
                      <option value="">{ti.notInFile}</option>
                      {batch.headers.slice(0, COLUMN_MAX).map((h, i) => (
                        <option key={i} value={String(i)}>
                          {h.trim() === "" ? `#${formatNumber(locale, i + 1)}` : h}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
              {problems.length > 0 ? (
                <ul className="import-problems" data-testid="import-mapping-problems">
                  {problems.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              ) : null}
              <div className="import-presets">
                <div className="import-inline">
                  <label className="field">
                    <span>{ti.presets}</span>
                    <select className="input" value={presetId} onChange={(e) => setPresetId(e.target.value)} disabled={!hydrated || working || presets.length === 0}>
                      <option value="">{ti.presetNone}</option>
                      {presets.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button type="button" className="btn btn-secondary" onClick={applyPreset} disabled={!hydrated || working || presetId === ""}>
                    {ti.presetApply}
                  </button>
                </div>
                <div className="import-inline">
                  <label className="field">
                    <span>{ti.presetName}</span>
                    <input className="input" value={presetName} maxLength={60} onChange={(e) => setPresetName(e.target.value)} disabled={!hydrated || working} />
                  </label>
                  <button type="button" className="btn btn-secondary" onClick={() => void savePreset()} disabled={!hydrated || working || presetName.trim() === ""} aria-busy={busy === "preset"}>
                    {ti.presetSave}
                  </button>
                </div>
              </div>
              <div className="import-actions">
                <button type="submit" className="btn btn-primary" disabled={!hydrated || working} aria-busy={busy === "validate"} data-testid="import-validate">
                  {busy === "validate" ? ti.validating : ti.validate}
                </button>
              </div>
            </form>
          ) : null}
        </section>
      ) : null}

      {/* 2. Preview / rows */}
      {batch.status === "VALIDATED" || batch.status === "COMMITTED" ? (
        <section className="section" aria-labelledby={`${uid}-preview`} data-testid="import-preview">
          <div className="section-head">
            <h2 id={`${uid}-preview`}>{batch.status === "COMMITTED" ? ti.doneTitle : ti.previewTitle}</h2>
          </div>
          {batch.status === "COMMITTED" ? (
            <dl className="import-stats" data-testid="import-done-stats">
              {(["created", "updated", "skipped", "rejected"] as const).map((k) => (
                <div key={k} className="import-stat" data-testid={`import-stat-${k}`} data-tone={k === "rejected" && (s[k] ?? 0) > 0 ? "danger" : undefined}>
                  <dt>{ti.stats[k]}</dt>
                  <dd>{n(s[k])}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <dl className="import-stats" data-testid="import-summary">
              {(["total", "ok", "changed", "skipped", "rejected"] as const).map((k) => (
                <div key={k} className="import-stat" data-testid={`import-count-${k}`} data-tone={k === "rejected" && (s[k] ?? 0) > 0 ? "danger" : undefined}>
                  <dt>{ti.summary[k]}</dt>
                  <dd>{n(s[k])}</dd>
                </div>
              ))}
            </dl>
          )}
          {batch.status === "COMMITTED" ? (
            <ul className="import-notes">
              {(["priceNotApplied", "withoutBasePrice", "priceNotPermitted"] as const)
                .filter((k) => (s[k] ?? 0) > 0)
                .map((k) => (
                  <li key={k} data-testid={`import-stat-${k}`}>
                    {ti.stats[k]}: {n(s[k])}
                  </li>
                ))}
            </ul>
          ) : null}

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
                }}
                data-testid={`import-filter-${f}`}
              >
                {f === "ALL" ? ti.filterAll : ti.rowStatus[f]}
              </button>
            ))}
          </div>

          {rows.length === 0 ? (
            <p className="muted" data-testid="import-no-rows">
              {busy === "rows" ? ti.loading : ti.noRows}
            </p>
          ) : (
            <table className="data-table import-rows" aria-busy={busy === "rows"}>
              <thead>
                <tr>
                  <th scope="col">{ti.colItem}</th>
                  <th scope="col">{ti.colRow}</th>
                  <th scope="col">{t.catalog.import.colStatus}</th>
                  <th scope="col">{ti.colDetails}</th>
                  {batch.status === "VALIDATED" ? <th scope="col">{ti.colChoice}</th> : null}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const name = cell(row, "name");
                  const code = cell(row, "barcode") || cell(row, "sku");
                  const mine = overrides[row.rowNumber] ?? choice;
                  return (
                    <tr key={row.rowNumber} data-testid="import-row" data-status={row.status} data-row={row.rowNumber}>
                      <td>
                        <span className="import-row-name" dir="auto">
                          {name || "—"}
                        </span>
                        {code ? (
                          <span className="import-row-code muted" dir="ltr">
                            {code}
                          </span>
                        ) : null}
                      </td>
                      <td data-secondary className="import-row-num">
                        <span className="visually-hidden">{ti.colRow} </span>
                        {formatNumber(locale, row.rowNumber)}
                      </td>
                      <td>
                        <span className="badge" data-tone={statusTone(row.status)} data-testid="import-row-status">
                          {ti.rowStatus[row.status]}
                        </span>
                      </td>
                      <td className="import-row-details" data-testid="import-row-details">
                        {row.status === "CHANGED" || (row.status === "COMMITTED" && row.diff?.length && row.reason !== "CREATED") ? (
                          <ul className="import-diff">
                            {(row.diff ?? []).map((d) => (
                              <li key={d.field}>
                                <span className="import-diff-field">{fieldLabel(d.field)}:</span>{" "}
                                <del dir="auto">{shown(d, d.before)}</del> <span aria-hidden="true">{dirOf(locale) === "rtl" ? "←" : "→"}</span>{" "}
                                <ins dir="auto">{shown(d, d.after)}</ins>
                              </li>
                            ))}
                          </ul>
                        ) : null}
                        {row.reason && row.reason !== "NOT_VALIDATED" ? (
                          <span className={row.status === "REJECTED" ? "import-reason import-reason-danger" : "import-reason"} data-testid="import-row-reason">
                            {ti.reasons[row.reason as keyof typeof ti.reasons] ?? row.reason}
                          </span>
                        ) : null}
                      </td>
                      {batch.status === "VALIDATED" ? (
                        <td>
                          {row.status === "CHANGED" ? (
                            <select
                              className="input import-choice"
                              aria-label={fill(ti.choiceFor, { row: formatNumber(locale, row.rowNumber) })}
                              value={mine}
                              disabled={!hydrated || working || committedAny}
                              onChange={(e) => {
                                const v = e.target.value as Choice;
                                setOverrides((o) => {
                                  const next = { ...o };
                                  if (v === choice) delete next[row.rowNumber];
                                  else next[row.rowNumber] = v;
                                  return next;
                                });
                              }}
                              data-testid="import-row-choice"
                            >
                              <option value="UPDATE">{ti.update}</option>
                              <option value="SKIP">{ti.skip}</option>
                            </select>
                          ) : null}
                        </td>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}

          {pages > 1 ? (
            <nav className="import-pager" aria-label={fill(ti.page, { page: n(page + 1), pages: n(pages) })}>
              <button type="button" className="btn btn-secondary btn-small" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0 || busy === "rows"} data-testid="import-prev">
                {ti.prev}
              </button>
              <span className="muted" aria-live="polite">
                {fill(ti.page, { page: n(page + 1), pages: n(pages) })}
              </span>
              <button
                type="button"
                className="btn btn-secondary btn-small"
                onClick={() => setPage((p) => Math.min(pages - 1, p + 1))}
                disabled={page >= pages - 1 || busy === "rows"}
                data-testid="import-next"
              >
                {ti.next}
              </button>
            </nav>
          ) : null}
        </section>
      ) : null}

      {/* 3. Decisions and save */}
      {batch.status === "VALIDATED" ? (
        <section className="section panel import-confirm" aria-labelledby={`${uid}-save`} data-testid="import-confirm">
          <h2 id={`${uid}-save`}>{ti.confirmTitle}</h2>
          {committedAny ? (
            <Notice tone="danger">
              <span data-testid="import-partial">{fill(ti.partial, { count: n(batch.committedRows) })}</span>
            </Notice>
          ) : null}
          {(s.changed ?? 0) > 0 && !committedAny ? (
            <fieldset className="fieldset import-choice-all">
              <legend>
                {ti.changedTitle} ({n(s.changed)})
              </legend>
              <span className="hint">{ti.changedHint}</span>
              <div className="import-inline">
                {(["UPDATE", "SKIP"] as const).map((c) => (
                  <label key={c} className="check">
                    <input
                      type="radio"
                      name={`${uid}-all`}
                      value={c}
                      checked={choice === c}
                      onChange={() => {
                        setChoice(c);
                        setOverrides({});
                      }}
                      disabled={!hydrated || working}
                      data-testid={`import-all-${c}`}
                    />
                    {c === "UPDATE" ? ti.updateAll : ti.skipAll}
                  </label>
                ))}
              </div>
            </fieldset>
          ) : null}
          <p data-testid="import-confirm-body">
            {fill(ti.confirmBody, {
              ok: n(s.ok),
              update: n(updateCount),
              skip: n((s.changed ?? 0) - updateCount),
              rejected: n(s.rejected),
            })}
          </p>
          <div className="import-actions">
            <button type="button" className="btn btn-primary" onClick={() => void commit()} disabled={!hydrated || working} aria-busy={busy === "commit"} data-testid="import-commit">
              {committedAny ? ti.resume : ti.commit}
            </button>
            {busy === "commit" ? (
              <span className="muted" role="status" data-testid="import-committing">
                {ti.committing}
              </span>
            ) : null}
          </div>
        </section>
      ) : null}

      {/* 4. After saving */}
      {batch.status === "COMMITTED" ? (
        <section className="section panel" data-testid="import-done">
          {(s.rejected ?? 0) > 0 ? (
            <>
              <p className="muted">{ti.downloadHint}</p>
              <div className="import-actions">
                <button type="button" className="btn btn-primary" onClick={() => void download()} disabled={!hydrated || working} aria-busy={busy === "download"} data-testid="import-download-rejected">
                  {ti.downloadRejected}
                </button>
                <Link href="/retail/catalog" className="btn btn-secondary">
                  {ti.openCatalog}
                </Link>
              </div>
            </>
          ) : (
            <div className="import-actions">
              <Link href="/retail/catalog" className="btn btn-primary">
                {ti.openCatalog}
              </Link>
            </div>
          )}
        </section>
      ) : null}

      {/* Delete: only while nothing of the file is in the catalog. */}
      {!committedAny ? (
        <section className="section">
          {confirmDelete ? (
            <div className="confirm" role="group" aria-label={ti.delete}>
              <span>{ti.deleteConfirm}</span>
              <div className="confirm-actions">
                <button type="button" className="btn btn-danger-solid" onClick={() => void remove()} disabled={!hydrated || working} aria-busy={busy === "delete"} data-testid="import-delete-yes">
                  {ti.deleteYes}
                </button>
                <button type="button" className="btn btn-secondary" onClick={() => setConfirmDelete(false)} disabled={working}>
                  {ti.cancel}
                </button>
              </div>
            </div>
          ) : (
            <button type="button" className="btn btn-danger" onClick={() => setConfirmDelete(true)} disabled={!hydrated || working} data-testid="import-delete">
              {ti.delete}
            </button>
          )}
        </section>
      ) : null}
    </div>
  );
}

function statusTone(status: RowStatusDto): "accent" | "warn" | "danger" | undefined {
  if (status === "OK" || status === "COMMITTED") return "accent";
  if (status === "CHANGED") return "warn";
  if (status === "REJECTED") return "danger";
  return undefined;
}

function baseName(name: string): string {
  return name.replace(/\.[^.]*$/, "").replace(/[\\/:*?"<>|]+/g, "_").slice(0, 80) || "import";
}
