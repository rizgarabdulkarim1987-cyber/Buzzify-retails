"use server";

import { createHash } from "node:crypto";
import { commitOpeningSlice, downloadOpeningRejected, getOpeningImport, stageOpeningImport, validateOpeningImport } from "@/server/stock/import";
import { call, fail, metaFor } from "../../catalog/_lib/call";
import { isRowStatus, OPENING_FIELDS, rowDto, type OpeningMappingDto, type OpeningRowsPage, type OpeningStatsDto } from "../_lib/opening-import";
import type { StockResult } from "../_lib/types";

/*
 * The browser's door to the opening-stock import (src/server/stock/import.ts). Thin wrappers: the
 * session and business from the server, every check in the actions (stock.receive and
 * catalog.import, the cost column lock, the same-file refusal). Posting runs one slice (up to 500
 * rows, one document) per call, so the screen can show its progress and continue after a stop.
 */

type Wire = Record<string, unknown>;
const str = (v: unknown, max = 64): string => (typeof v === "string" ? v.slice(0, max) : "");
const MAX_SLICE_ATTEMPTS = 4;

function mappingOf(raw: unknown): OpeningMappingDto | null {
  if (typeof raw !== "object" || raw === null) return null;
  const m = raw as Wire;
  const out = {} as OpeningMappingDto;
  for (const f of OPENING_FIELDS) {
    const v = m[f];
    if (v === null || v === undefined) out[f] = null;
    else if (typeof v === "number" && Number.isInteger(v) && v >= 0 && v < 200) out[f] = v;
    else return null;
  }
  return out;
}

/** The file as base64 (read in the browser) and its name; the wizard of the new batch opens next. */
export async function stageOpeningAction(key: unknown, input: Wire): Promise<StockResult<{ batchId: string }>> {
  return call(key, (m) => stageOpeningImport({ fileName: str(input.fileName, 255), contentBase64: str(input.contentBase64, 16_000_000) }, m), (v) => ({ batchId: v.batchId }));
}

/** Checks every row against the mapping; the page then shows the preview (router.refresh). */
export async function validateOpeningAction(key: unknown, input: Wire): Promise<StockResult<{ version: number }>> {
  const mapping = mappingOf(input.mapping);
  if (!mapping) return fail("INVALID_INPUT");
  return call(key, (m) => validateOpeningImport({ batchId: str(input.batchId), mapping }, m), (v) => ({ version: v.version }));
}

/** One page of rows, optionally of one status. */
export async function openingRowsAction(input: Wire): Promise<StockResult<OpeningRowsPage>> {
  const status = isRowStatus(input.status) ? input.status : undefined;
  const page = typeof input.page === "number" && Number.isInteger(input.page) && input.page >= 0 && input.page <= 1000 ? input.page : 0;
  return call(
    "",
    (m) => getOpeningImport({ batchId: str(input.batchId), ...(status ? { status } : {}), page }, m),
    (v) => ({ rows: v.rows.map(rowDto), rowCount: v.rowCount, postedRows: v.postedRows }),
  );
}

export type SliceDto =
  | { done: false; posted: number; number: number | null }
  | { done: true; stats: OpeningStatsDto; alreadyCommitted: boolean; numbers: number[]; valueMinor?: string };

/**
 * Posts slice `n` of a run. `key` names the run: the slice's own key is derived from it and `n`
 * (as commitOpeningImport does), so a slice sent again after a lost answer replays; a new run
 * (resume) gets a new key and continues from the rows not yet posted. A slice that met a
 * concurrent writer is retried a few times.
 */
export async function commitOpeningSliceAction(key: unknown, n: unknown, input: Wire): Promise<StockResult<SliceDto>> {
  const slice = typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 1000 ? n : null;
  const expectedVersion = typeof input.expectedVersion === "number" && Number.isInteger(input.expectedVersion) ? input.expectedVersion : undefined;
  if (typeof key !== "string" || key === "" || slice === null) return fail("INVALID_INPUT");
  const meta = await metaFor("");
  if (!meta) return fail("FORBIDDEN");
  const base = createHash("sha256").update(key).digest("hex").slice(0, 40);
  const payload = { batchId: str(input.batchId), includeHasStock: input.includeHasStock === true, ...(expectedVersion !== undefined ? { expectedVersion } : {}) };
  let last: StockResult<SliceDto> = fail("INTERNAL");
  for (let attempt = 1; attempt <= MAX_SLICE_ATTEMPTS; attempt += 1) {
    last = await call(`opening-commit:${base}:${slice}`, (m) => commitOpeningSlice(payload, m), (v): SliceDto =>
      v.done
        ? {
            done: true,
            stats: v.stats,
            alreadyCommitted: v.alreadyCommitted,
            numbers: v.documents.map((d) => d.number).filter((x): x is number => x !== null),
            ...(v.valueMinor !== undefined ? { valueMinor: v.valueMinor.toString() } : {}),
          }
        : { done: false, posted: v.posted, number: v.number },
    );
    if (last.ok || last.code !== "VERSION_CONFLICT" || last.details?.retry !== "true") break;
  }
  return last;
}

/** The rejected rows as CSV text (UTF-8 with BOM; cost cells blank without cost.view). */
export async function downloadOpeningRejectedAction(batchId: unknown): Promise<StockResult<string>> {
  return call("", (m) => downloadOpeningRejected({ batchId: str(batchId) }, m));
}
