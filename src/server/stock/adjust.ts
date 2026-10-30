import { z } from "zod";
import type { RtStockDirection } from "@/generated/prisma/enums";
import { can } from "@/server/domain/permissions";
import type { StockReason } from "@/server/domain/stock";
import type { Actor } from "@/server/framework/actor";
import { defineAction } from "@/server/framework/action";
import { NotFoundError, RuleError, VersionConflictError } from "@/server/framework/errors";
import {
  businessOf,
  checkLine,
  defaultPlace,
  documentLock,
  loadCatalog,
  postDocumentInTx,
  refuse,
  withoutCosts,
  type LockBusiness,
  type PostedDocument,
  type Tx,
} from "./posting";

/*
 * Stock adjustments (ADJUSTMENT, IN or OUT), write-offs (WRITE_OFF, always OUT) and reversals
 * (REVERSAL). Each action creates its document and posts it at once in its own transaction
 * (postDocumentInTx): numbered, audited, idempotent through the key. No draft is ever left behind.
 *
 * Permission stock.adjust for all three (OWNER, MANAGER, STOCK). Values and costs are returned only
 * with cost.view; the stored idempotency value never holds them (storedValue), as for receipts.
 *
 * adjustStock / writeOffStock:
 * - reason (spec 3.9) is required: adjust LOST | COUNT_FIX | OTHER, write-off DAMAGED | EXPIRED |
 *   OTHER; OTHER needs a non-blank note. Malformed input (missing or wrong reason, a missing note,
 *   a quantity the unit cannot hold) is INVALID_INPUT.
 * - The variant and unit exist (NOT_FOUND), the unit is the variant's, trial and SERIAL items are
 *   refused (TEST_ITEM, SERIAL_NOT_SUPPORTED), an archived item cannot come IN (it can still go out).
 * - batchId: only for a BATCH product (BATCH_NOT_TRACKED otherwise). Required when the product
 *   tracksExpiry (BATCH_REQUIRED; its receipts always carry a date, so its stock is on batches).
 *   For a BATCH product without tracksExpiry it is optional: null or omitted means the no-batch
 *   row (receipts without a code or date land there). A named batch exists (NOT_FOUND) and is of
 *   that variant (BATCH_NOT_OF_VARIANT); the line copies its code and expiry date.
 * - IN is valued at the current average (0 with a COST_UNKNOWN warning without stock), OUT at the
 *   ledger's average; an outflow beyond the (location, variant, batch) balance is STOCK_NEGATIVE.
 * - The document is in the default location of the actor's branch (as a receipt), with the
 *   direction, the reason and the note.
 *
 * reverseStockDocument({documentId, expectedVersion}): the original must be a POSTED OPENING,
 * RECEIPT, ADJUSTMENT or WRITE_OFF of the actor's scope (NOT_FOUND otherwise), not itself a
 * REVERSAL (STOCK_RULE reason REVERSAL), posted (NOT_POSTED), not reversed yet (ALREADY_REVERSED;
 * the unique reversesDocumentId is the backstop), at expectedVersion (VERSION_CONFLICT). The
 * reversal is in the original's branch and location, carries its reason and note, mirrors its lines
 * (same numbers, units, quantities, batches, costs and values) and negates its movements exactly;
 * STOCK_NEGATIVE when the stock is no longer there; STOCK_RULE {reason: REVERSAL_VALUE_MISMATCH}
 * when the stock is there but its value no longer fits the original values (average-cost outflows
 * since), including a reversal that would leave the item at quantity 0 with a value.
 *
 * Locks: idempotency -> (reversal: `stock-doc:<originalId>`, so two reversals of one document
 * serialize) -> `stock-doc:<newId>` -> `stock:<variantId>` ascending -> `stock-doc-number`.
 */

const MAX_NOTE_LENGTH = 1000;

const ADJUST_REASONS = ["LOST", "COUNT_FIX", "OTHER"] as const satisfies readonly StockReason[];
const WRITE_OFF_REASONS = ["DAMAGED", "EXPIRED", "OTHER"] as const satisfies readonly StockReason[];
const REVERSIBLE_KINDS = ["OPENING", "RECEIPT", "ADJUSTMENT", "WRITE_OFF"] as const;

const id = z.string().min(1).max(64);
const note = z
  .string()
  .trim()
  .max(MAX_NOTE_LENGTH)
  .nullish()
  .transform((v) => (v ? v : null));
const movementFields = {
  variantId: id,
  unitId: id,
  batchId: id.nullish().transform((v) => v ?? null),
  /** As typed in the unit (Arabic digits accepted). */
  quantity: z.string().min(1).max(40),
  note,
};
const otherNeedsNote = (v: { reason: string; note: string | null }) => v.reason !== "OTHER" || v.note !== null;

const adjustInput = z
  .object({ ...movementFields, direction: z.enum(["IN", "OUT"]), reason: z.enum(ADJUST_REASONS) })
  .strict()
  .refine(otherNeedsNote);
const writeOffInput = z
  .object({ ...movementFields, reason: z.enum(WRITE_OFF_REASONS) })
  .strict()
  .refine(otherNeedsNote);
const reverseInput = z.object({ documentId: id, expectedVersion: z.number().int().min(1) }).strict();

type Movement = {
  kind: "ADJUSTMENT" | "WRITE_OFF";
  direction: RtStockDirection;
  reason: StockReason;
  note: string | null;
  variantId: string;
  unitId: string;
  batchId: string | null;
  quantity: string;
};

/** Checks the one line, creates the document with it and posts it (see the header). */
async function postMovementDocument(tx: Tx, actor: Actor, m: Movement, lockBusiness: LockBusiness): Promise<PostedDocument> {
  const biz = await businessOf(tx);
  const catalog = await loadCatalog(tx, [m]);
  const lineData = {
    lineNo: 1,
    variantId: m.variantId,
    unitId: m.unitId,
    enteredQuantity: m.quantity.trim(),
    batchCode: null,
    expiryDate: null,
    currency: null,
    unitCostMinor: null,
    rateMicro: null,
  };
  // Refuses here what the line's foreign keys would (an unknown or foreign variant or batch);
  // the quantity is parsed in the unit's scale (INVALID_INPUT).
  const { variant, quantity } = checkLine(lineData, catalog, biz, { allowArchived: m.direction === "OUT" });
  let batch: { code: string | null; expiryDate: Date | null } = { code: null, expiryDate: null };
  if (variant.product.trackingMode === "BATCH") {
    if (m.batchId === null && variant.product.tracksExpiry) refuse(1, "BATCH_REQUIRED");
    if (m.batchId !== null) {
      const found = await tx.rtBatch.findFirst({ where: { id: m.batchId }, select: { variantId: true, code: true, expiryDate: true } });
      if (!found) throw new NotFoundError();
      if (found.variantId !== m.variantId) refuse(1, "BATCH_NOT_OF_VARIANT");
      batch = found;
    }
  } else if (m.batchId !== null) {
    refuse(1, "BATCH_NOT_TRACKED");
  }

  const place = await defaultPlace(tx);
  const doc = await tx.rtStockDocument.create({
    data: { businessId: actor.businessId, ...place, kind: m.kind, direction: m.direction, reason: m.reason, note: m.note },
    select: { id: true },
  });
  await tx.rtStockLine.create({
    data: {
      businessId: actor.businessId,
      branchId: place.branchId,
      documentId: doc.id,
      lineNo: 1,
      variantId: m.variantId,
      unitId: m.unitId,
      batchId: m.batchId,
      batchCode: batch.code,
      expiryDate: batch.expiryDate,
      quantity,
      enteredQuantity: lineData.enteredQuantity,
    },
  });
  return postDocumentInTx(tx, actor, doc.id, lockBusiness);
}

const shown = (actor: Actor, posted: PostedDocument) => (can(actor.role, "cost.view") ? posted : withoutCosts(posted));

const auditOf = (value: PostedDocument) => ({
  entity: "RtStockDocument",
  entityId: value.documentId,
  changes: {
    kind: value.kind,
    number: value.number,
    direction: value.direction,
    reversesDocumentId: value.reversesDocumentId,
    lines: value.lines.length,
    warnings: value.warnings.length,
  },
});

/** An adjustment IN or OUT, posted at once. Costs in the result only with cost.view; never stored. */
export const adjustStock = defineAction({
  name: "stock.adjust",
  permission: "stock.adjust",
  input: adjustInput,
  writes: true,
  timeoutMs: 20_000,
  async run({ actor, tx, input, lockBusiness }): Promise<PostedDocument> {
    const posted = await postMovementDocument(tx, actor, { ...input, kind: "ADJUSTMENT" }, lockBusiness);
    return shown(actor, posted);
  },
  storedValue: withoutCosts,
  audit: (input, value) => {
    const a = auditOf(value);
    return { ...a, changes: { ...a.changes, reason: input.reason } };
  },
});

/** A write-off (always OUT), posted at once. Costs in the result only with cost.view; never stored. */
export const writeOffStock = defineAction({
  name: "stock.writeOff",
  permission: "stock.adjust",
  input: writeOffInput,
  writes: true,
  timeoutMs: 20_000,
  async run({ actor, tx, input, lockBusiness }): Promise<PostedDocument> {
    const posted = await postMovementDocument(tx, actor, { ...input, kind: "WRITE_OFF", direction: "OUT" }, lockBusiness);
    return shown(actor, posted);
  },
  storedValue: withoutCosts,
  audit: (input, value) => {
    const a = auditOf(value);
    return { ...a, changes: { ...a.changes, reason: input.reason } };
  },
});

/** Reverses a posted document exactly (see the header). Costs in the result only with cost.view; never stored. */
export const reverseStockDocument = defineAction({
  name: "stock.reverse",
  permission: "stock.adjust",
  input: reverseInput,
  writes: true,
  timeoutMs: 30_000,
  async run({ actor, tx, input, lockBusiness }): Promise<PostedDocument> {
    await lockBusiness(documentLock(input.documentId));
    const original = await tx.rtStockDocument.findFirst({
      where: { id: input.documentId },
      select: { id: true, kind: true, status: true, version: true, branchId: true, locationId: true, reason: true, note: true },
    });
    if (!original) throw new NotFoundError();
    if (original.kind === "REVERSAL") throw new RuleError("STOCK_RULE", { reason: "REVERSAL" });
    if (!(REVERSIBLE_KINDS as readonly string[]).includes(original.kind)) throw new RuleError("STOCK_RULE", { reason: "KIND" });
    if (original.status !== "POSTED") throw new RuleError("STOCK_RULE", { reason: "NOT_POSTED" });
    const reversed = await tx.rtStockDocument.findFirst({ where: { reversesDocumentId: original.id }, select: { id: true } });
    if (reversed) throw new RuleError("STOCK_RULE", { reason: "ALREADY_REVERSED" });
    if (original.version !== input.expectedVersion) throw new VersionConflictError();

    const doc = await tx.rtStockDocument.create({
      data: {
        businessId: actor.businessId,
        branchId: original.branchId,
        locationId: original.locationId,
        kind: "REVERSAL",
        reversesDocumentId: original.id,
        reason: original.reason,
        note: original.note,
      },
      select: { id: true },
    });
    const lines = await tx.rtStockLine.findMany({
      where: { documentId: original.id },
      orderBy: { lineNo: "asc" },
      select: {
        lineNo: true,
        variantId: true,
        unitId: true,
        batchId: true,
        batchCode: true,
        expiryDate: true,
        quantity: true,
        enteredQuantity: true,
        currency: true,
        unitCostMinor: true,
        rateMicro: true,
        valueMinor: true,
      },
    });
    await tx.rtStockLine.createMany({
      data: lines.map((l) => ({ ...l, businessId: actor.businessId, branchId: original.branchId, documentId: doc.id })),
    });
    const posted = await postDocumentInTx(tx, actor, doc.id, lockBusiness);
    return shown(actor, posted);
  },
  storedValue: withoutCosts,
  audit: (_input, value) => auditOf(value),
});
