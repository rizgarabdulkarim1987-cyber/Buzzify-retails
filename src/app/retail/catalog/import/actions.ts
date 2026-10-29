"use server";

import {
  commitImport,
  deleteImportBatch,
  downloadRejected,
  getImportBatch,
  listChangedRows,
  saveMappingPreset,
  stageImport,
  validateImport,
} from "@/server/catalog/import/actions";
import { call, fail } from "../_lib/call";
import type { UiResult } from "../_lib/types";
import type { BatchStats, Choice, ImportRowDto, MappingDto, PresetDto, RowStatusDto, RowsPage } from "./_lib/types";

/*
 * The browser's door to the import actions (src/server/catalog/import/actions.ts). Thin wrappers,
 * as in ../actions.ts: session and business from the server, every check in the actions.
 */

type Wire = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const isChoice = (v: unknown): v is Choice => v === "UPDATE" || v === "SKIP";
const STATUSES = new Set<RowStatusDto>(["OK", "CHANGED", "SKIPPED", "REJECTED", "COMMITTED"]);

function rowDto(r: { rowNumber: number; status: string; reason: string | null; raw: unknown; diff: unknown; resolution: string | null }): ImportRowDto {
  return {
    rowNumber: r.rowNumber,
    status: r.status as RowStatusDto,
    reason: r.reason,
    raw: Array.isArray(r.raw) ? r.raw.map((c) => (typeof c === "string" ? c : "")) : [],
    diff: Array.isArray(r.diff) ? (r.diff as ImportRowDto["diff"]) : null,
    resolution: isChoice(r.resolution) ? r.resolution : null,
  };
}

export type Staged = { batchId: string; sameFileBatchId: string | null };

/** The file as base64 (read in the browser), its name, and whether it holds trial items (setup wizard). */
export async function stageImportAction(key: unknown, input: Wire): Promise<UiResult<Staged>> {
  return call(
    key,
    (m) => stageImport({ fileName: str(input.fileName).slice(0, 255), contentBase64: str(input.contentBase64), isTestData: input.isTestData === true }, m),
    (v) => ({ batchId: v.batchId, sameFileBatchId: v.sameFileBatchId }),
  );
}

export async function validateImportAction(key: unknown, input: Wire): Promise<UiResult<{ version: number }>> {
  return call(key, (m) => validateImport({ batchId: str(input.batchId), mapping: input.mapping }, m), (v) => ({ version: v.version }));
}

/** One page of rows, optionally of one status. */
export async function loadRowsAction(input: Wire): Promise<UiResult<RowsPage>> {
  const status = STATUSES.has(input.status as RowStatusDto) ? (input.status as RowStatusDto) : undefined;
  const page = typeof input.page === "number" && Number.isInteger(input.page) && input.page >= 0 ? input.page : 0;
  return call(
    "",
    (m) => getImportBatch({ batchId: str(input.batchId), ...(status ? { status } : {}), page }, m),
    (v) => ({ rows: v.rows.map(rowDto), rowCount: v.rowCount, committedRows: v.committedRows }),
  );
}

/**
 * Saves the batch: `choice` for every changed row, except the rows named in `overrides` (row number
 * -> UPDATE / SKIP). The action takes either one choice for all or a per-row map in which an
 * unnamed row is SKIP, so "update all but these" is spelled out row by row here.
 */
export async function commitImportAction(key: unknown, input: Wire): Promise<UiResult<{ stats: BatchStats }>> {
  const batchId = str(input.batchId);
  const choice = isChoice(input.choice) ? input.choice : "SKIP";
  const overrides = new Map<number, Choice>();
  const raw = typeof input.overrides === "object" && input.overrides !== null ? (input.overrides as Wire) : {};
  for (const [k, v] of Object.entries(raw)) {
    const n = Number(k);
    if (Number.isInteger(n) && n >= 1 && n <= 99_999 && isChoice(v) && v !== choice) overrides.set(n, v);
  }
  const expectedVersion = typeof input.expectedVersion === "number" ? input.expectedVersion : undefined;

  let onChange: Choice | Record<string, Choice> = choice;
  if (overrides.size > 0) {
    let changed: number[] = [];
    if (choice === "UPDATE") {
      const list = await call("", (m) => listChangedRows({ batchId }, m));
      if (!list.ok) return list;
      changed = list.value;
    }
    const map: Record<string, Choice> = {};
    for (const n of changed) map[String(n)] = "UPDATE";
    for (const [n, v] of overrides) map[String(n)] = v;
    onChange = map;
  }
  return call(key, (m) => commitImport({ batchId, onChange, ...(expectedVersion !== undefined ? { expectedVersion } : {}) }, m), (v) => ({ stats: v.stats as BatchStats }));
}

/** The rejected rows as CSV text (UTF-8 with BOM, formula cells neutralised by the action). */
export async function downloadRejectedAction(batchId: unknown): Promise<UiResult<string>> {
  return call("", (m) => downloadRejected({ batchId: str(batchId) }, m));
}

export async function deleteBatchAction(key: unknown, batchId: unknown): Promise<UiResult<{ done: true }>> {
  return call(key, (m) => deleteImportBatch({ batchId: str(batchId) }, m), () => ({ done: true as const }));
}

export async function savePresetAction(key: unknown, input: Wire): Promise<UiResult<PresetDto>> {
  const name = str(input.name).trim();
  if (name === "") return fail("INVALID_INPUT");
  return call(key, (m) => saveMappingPreset({ name, mapping: input.mapping }, m), (p) => ({ id: p.id, name: p.name, mapping: p.mapping as MappingDto }));
}
