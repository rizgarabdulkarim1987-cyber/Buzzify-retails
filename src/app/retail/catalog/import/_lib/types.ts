import type { KnownColumn } from "@/server/catalog/import/mapping";

export type RowStatusDto = "OK" | "CHANGED" | "SKIPPED" | "REJECTED" | "COMMITTED";
export type Choice = "UPDATE" | "SKIP";
export type MappingDto = Record<KnownColumn, number | null>;

/** One stored row as the browser receives it (the file's own cells, never more than the header width). */
export type ImportRowDto = {
  rowNumber: number;
  status: RowStatusDto;
  reason: string | null;
  raw: string[];
  diff: { field: string; before: string | null; after: string }[] | null;
  resolution: Choice | null;
};
export type RowsPage = { rows: ImportRowDto[]; rowCount: number; committedRows: number };

export type PresetDto = { id: string; name: string; mapping: MappingDto };

/** The batch's counters: after validation the preview counts, after commit the commit stats. */
export type BatchStats = Partial<
  Record<"ok" | "changed" | "skipped" | "rejected" | "total" | "created" | "updated" | "priceNotPermitted" | "priceNotApplied" | "withoutBasePrice", number>
>;

export const ROWS_PER_PAGE = 50;
/** The file size the server accepts (MAX_IMPORT_FILE_BYTES), checked in the browser first to fail fast. */
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
