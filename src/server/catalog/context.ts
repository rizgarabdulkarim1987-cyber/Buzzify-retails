import { z } from "zod";
import type { RtRole } from "@/generated/prisma/client";
import type { Currency } from "@/generated/prisma/enums";
import { defineAction } from "@/server/framework/action";

/*
 * What the catalog screens need to know about the business before they draw: the caller's role
 * (to decide which controls to show; every write still checks the permission itself) and the
 * business's currencies. A read open to any active member.
 */
export type CatalogContext = { role: RtRole; defaultCurrency: Currency; enabledCurrencies: Currency[] };

export const catalogContext = defineAction({
  name: "catalog.context",
  permission: null,
  input: z.object({}).strict(),
  writes: false,
  async run({ actor, tx }): Promise<CatalogContext> {
    const biz = await tx.rtBusiness.findFirstOrThrow({ select: { defaultCurrency: true, enabledCurrencies: true } });
    return { role: actor.role, defaultCurrency: biz.defaultCurrency, enabledCurrencies: biz.enabledCurrencies };
  },
});
