import { z } from "zod";
import { defineAction } from "@/server/framework/action";
import { readSale, type SaleView } from "./sales";
import { openShiftOf } from "./shifts";

/*
 * The receipts list of the till: the last sales of the actor's own OPEN shift, newest first, each as the
 * receipt shows it (lines, payments, no cost). Another cashier's sales and closed shifts are not shown.
 */
export const MAX_RECENT_SALES = 20;

export const listRecentSales = defineAction({
  name: "sale.recent",
  permission: "sale.create",
  input: z.object({ limit: z.number().int().min(1).max(MAX_RECENT_SALES).default(10) }).strict(),
  writes: false,
  async run({ actor, tx, input }): Promise<SaleView[]> {
    const shift = await openShiftOf(tx, actor);
    if (!shift) return [];
    const rows = await tx.rtSale.findMany({
      where: { shiftId: shift.id },
      orderBy: [{ postedAt: "desc" }, { number: "desc" }],
      take: input.limit,
      select: { id: true },
    });
    const views = await Promise.all(rows.map((r) => readSale(tx, { id: r.id })));
    return views.filter((v): v is SaleView => v !== null);
  },
});
