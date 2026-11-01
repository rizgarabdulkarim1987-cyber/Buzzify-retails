import { z } from "zod";
import { can } from "@/server/domain/permissions";
import { autoMapOpeningHeaders } from "@/server/stock/import";
import { defineAction } from "@/server/framework/action";
import { ForbiddenError, NotFoundError } from "@/server/framework/errors";

/*
 * Two small reads the stock screens need and the stock actions do not return: the business's time
 * zone (the receiving form's "today" for expiry hints) and the columns of an opening-stock file the
 * server treats as cost columns. Read only; neither adds a cost value to anything.
 */

const id = z.string().min(1).max(64);

/** The business's time zone, as the server uses it for the business day (businessToday). */
export const businessTimezone = defineAction({
  name: "stock.screen.timezone",
  permission: "stock.view",
  input: z.object({}).strict(),
  writes: false,
  async run({ tx }): Promise<string> {
    const biz = await tx.rtBusiness.findFirstOrThrow({ select: { timezone: true } });
    return biz.timezone;
  },
});

type StoredMapping = { columns?: { cost?: number | null }; costColumns?: number[] };

/**
 * The column indexes of an opening-stock file that hold costs, as the server locks them for a role
 * without cost.view: every column ever mapped as cost, the suggested cost column and the current one
 * (the same set as costColumnsOf in src/server/stock/import.ts). Indexes only, never cells.
 */
export const openingCostColumns = defineAction({
  name: "stock.screen.importCostColumns",
  permission: "stock.receive",
  precondition: async ({ actor }) => {
    if (!can(actor.role, "catalog.import")) throw new ForbiddenError();
  },
  input: z.object({ batchId: id }).strict(),
  writes: false,
  async run({ tx, input }): Promise<number[]> {
    const batch = await tx.rtImportBatch.findFirst({ where: { id: input.batchId, kind: "OPENING_STOCK" }, select: { columns: true, mapping: true } });
    if (!batch) throw new NotFoundError();
    const headers = Array.isArray(batch.columns) ? batch.columns.map((c) => (typeof c === "string" ? c : "")) : [];
    const mapping = (batch.mapping as StoredMapping | null) ?? null;
    const out = new Set<number>((mapping?.costColumns ?? []).filter((n) => Number.isInteger(n)));
    const auto = autoMapOpeningHeaders(headers).cost;
    if (auto !== null) out.add(auto);
    const current = mapping?.columns?.cost;
    if (typeof current === "number") out.add(current);
    return [...out].sort((a, b) => a - b);
  },
});
