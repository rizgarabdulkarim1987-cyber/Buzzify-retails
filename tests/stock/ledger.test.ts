import { describe, expect, it } from "vitest";
import { z } from "zod";
import { MAX_BASE_QTY, convertMinor, lineValueMinor, parseRate } from "@/server/domain/stock";
import { defineAction } from "@/server/framework/action";
import { scopedDb } from "@/server/framework/scoped-db";
import { isNegativeBalance, postMovements, rebuildBalances, variantAverage } from "@/server/stock/ledger";
import { useTestDb } from "../helpers/db";
import { createBusinessWithStaff, createPlan } from "../helpers/fixtures";

const { db } = useTestDb();

const U = 1000n; // one base unit (quantities are base x 1000)

/** A test-only write action: the real scoped tx and the real lockBusiness of defineAction. */
const post = defineAction({
  name: "test.stock.post",
  permission: null,
  input: z.object({
    documentId: z.string(),
    branchId: z.string(),
    locationId: z.string(),
    lines: z.array(
      z.object({
        lineId: z.string(),
        variantId: z.string(),
        batchId: z.string().nullable(),
        qtyDelta: z.bigint(),
        valueDeltaMinor: z.bigint().optional(),
      }),
    ),
    exactValues: z.boolean().optional(),
  }),
  writes: true,
  timeoutMs: 30_000,
  run: ({ actor, tx, input, lockBusiness }) => postMovements(tx, { businessId: actor.businessId, ...input }, lockBusiness),
});

/** A read action returning variantAverage through the scoped tx. */
const average = defineAction({
  name: "test.stock.average",
  permission: null,
  input: z.object({ locationId: z.string(), variantId: z.string() }),
  writes: false,
  run: ({ tx, input }) => variantAverage(tx, input.locationId, input.variantId),
});

let keySeq = 0;
let skuSeq = 0;

/** Deterministic PRNG (mulberry32). */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * An active business (subscription, owner) with two branches, a location in each, `variants`
 * variants, and one draft document per location with one line per variant (movements reuse them).
 */
async function world(variants = 1) {
  if ((await db.rtPlan.count()) === 0) await createPlan(db, { maxBranches: 3 });
  const w = await createBusinessWithStaff(db, { branches: ["Main", "Second"], staff: [{ key: "o", role: "OWNER" }] });
  const businessId = w.business.id;
  await db.rtBusiness.update({ where: { id: businessId }, data: { status: "ACTIVE" } });
  await db.rtSubscription.create({
    data: {
      businessId,
      planCode: "basic",
      status: "ACTIVE",
      currentPeriodStart: new Date(Date.now() - 86_400_000),
      currentPeriodEnd: new Date(Date.now() + 86_400_000 * 30),
    },
  });
  const product = await db.rtProduct.create({ data: { businessId, nameAr: "حليب" } });
  const vs: { id: string }[] = [];
  const units: { id: string }[] = [];
  for (let i = 0; i < variants; i++) {
    const v = await db.rtVariant.create({ data: { businessId, productId: product.id, sku: `S-${++skuSeq}` } });
    vs.push(v);
    units.push(await db.rtUnit.create({ data: { businessId, variantId: v.id, name: "حبة", factor: 1, isBase: true } }));
  }
  const places = [];
  for (const name of ["Main", "Second"]) {
    const branchId = w.branches[name]!.id;
    const location = await db.rtLocation.create({ data: { businessId, branchId, name: "المخزن" } });
    const doc = await db.rtStockDocument.create({ data: { businessId, branchId, locationId: location.id, kind: "RECEIPT" } });
    const lineOf: Record<string, string> = {};
    for (let i = 0; i < vs.length; i++) {
      const l = await db.rtStockLine.create({
        data: {
          businessId,
          branchId,
          documentId: doc.id,
          lineNo: i + 1,
          variantId: vs[i]!.id,
          unitId: units[i]!.id,
          quantity: 1000n,
          enteredQuantity: "1",
        },
      });
      lineOf[vs[i]!.id] = l.id;
    }
    // A REVERSAL of that document with the same lines: the only kind postMovements takes exactValues for.
    const reversal = await db.rtStockDocument.create({
      data: { businessId, branchId, locationId: location.id, kind: "REVERSAL", reversesDocumentId: doc.id },
    });
    const reversalLineOf: Record<string, string> = {};
    for (let i = 0; i < vs.length; i++) {
      const l = await db.rtStockLine.create({
        data: {
          businessId,
          branchId,
          documentId: reversal.id,
          lineNo: i + 1,
          variantId: vs[i]!.id,
          unitId: units[i]!.id,
          quantity: 1000n,
          enteredQuantity: "1",
        },
      });
      reversalLineOf[vs[i]!.id] = l.id;
    }
    places.push({ branchId, locationId: location.id, documentId: doc.id, lineOf, reversalId: reversal.id, reversalLineOf });
  }
  const userId = w.staff.o!.user.id;
  const meta = () => ({ userId, businessId, idempotencyKey: `k-${++keySeq}` });
  const actor = { userId, businessId, role: "OWNER" as const, branchIds: "ALL" as const };
  const batch = (variantId: string, code: string) => db.rtBatch.create({ data: { businessId, variantId, code } });
  return { businessId, variants: vs.map((v) => v.id), places, meta, actor, batch };
}

type World = Awaited<ReturnType<typeof world>>;
type Move = { variantId: string; batchId?: string | null; qtyDelta: bigint; valueDeltaMinor?: bigint };

/**
 * Posts `moves` at place `p` of `w` in one transaction; resolves to the action result. With
 * exactValues the moves go on the place's REVERSAL document unless `onReceipt` is set.
 */
function postAt(w: World, moves: Move[], p = 0, exactValues?: boolean, onReceipt = false) {
  const place = w.places[p]!;
  const reversal = exactValues === true && !onReceipt;
  return post(
    {
      ...(exactValues === undefined ? {} : { exactValues }),
      documentId: reversal ? place.reversalId : place.documentId,
      branchId: place.branchId,
      locationId: place.locationId,
      lines: moves.map((m) => ({
        lineId: (reversal ? place.reversalLineOf : place.lineOf)[m.variantId]!,
        variantId: m.variantId,
        batchId: m.batchId ?? null,
        qtyDelta: m.qtyDelta,
        ...(m.valueDeltaMinor === undefined ? {} : { valueDeltaMinor: m.valueDeltaMinor }),
      })),
    },
    w.meta(),
  );
}

async function postOk(w: World, moves: Move[], p = 0) {
  const r = await postAt(w, moves, p);
  if (!r.ok) throw new Error(`post failed: ${r.code}`);
}

function rebuild(w: World, fix: boolean) {
  return db.$transaction((tx) => rebuildBalances(scopedDb(w.actor, tx), w.businessId, { fix }));
}

async function balance(w: World, variantId: string, batchId: string | null = null, p = 0) {
  const row = await db.rtStockBalance.findFirst({ where: { locationId: w.places[p]!.locationId, variantId, batchId } });
  return row && { qty: row.qty, valueMinor: row.valueMinor };
}

async function movementValues(w: World) {
  const rows = await db.rtStockMovement.findMany({ where: { businessId: w.businessId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  return rows.map((r) => [r.qtyDelta, r.valueDeltaMinor]);
}

describe("stock ledger", () => {
  it("receipt then outflow keeps value proportional and zeroes value at zero qty", async () => {
    const w = await world();
    const v = w.variants[0]!;
    await postOk(w, [{ variantId: v, qtyDelta: 3n * U, valueDeltaMinor: 1000n }]);
    await postOk(w, [{ variantId: v, qtyDelta: -1n * U }]);
    expect(await balance(w, v)).toEqual({ qty: 2n * U, valueMinor: 667n });
    await postOk(w, [{ variantId: v, qtyDelta: -2n * U }]);
    expect(await balance(w, v)).toEqual({ qty: 0n, valueMinor: 0n });
    expect(await movementValues(w)).toEqual([
      [3000n, 1000n],
      [-1000n, -333n],
      [-2000n, -667n],
    ]);
    const avg = await average({ locationId: w.places[0]!.locationId, variantId: v }, w.meta());
    expect(avg).toEqual({ ok: true, value: { qty: 0n, valueMinor: 0n } });
  });

  it("an outflow larger than the batch balance is STOCK_NEGATIVE and writes nothing", async () => {
    const w = await world();
    const v = w.variants[0]!;
    const a = await w.batch(v, "A");
    const b = await w.batch(v, "B");
    await postOk(w, [
      { variantId: v, batchId: a.id, qtyDelta: 2n * U, valueDeltaMinor: 200n },
      { variantId: v, batchId: b.id, qtyDelta: 10n * U, valueDeltaMinor: 1000n },
    ]);
    const before = { movements: await db.rtStockMovement.count(), balances: await db.rtStockBalance.findMany({ orderBy: { id: "asc" } }) };

    // The variant has 12 at the location, but batch A only 2.
    expect(await postAt(w, [{ variantId: v, batchId: a.id, qtyDelta: -3n * U }])).toMatchObject({ ok: false, code: "STOCK_NEGATIVE" });
    // A good line followed by a bad one: nothing of the call is kept.
    expect(
      await postAt(w, [
        { variantId: v, batchId: b.id, qtyDelta: -1n * U },
        { variantId: v, batchId: a.id, qtyDelta: -1n * U },
        { variantId: v, batchId: a.id, qtyDelta: -2n * U },
      ]),
    ).toMatchObject({ ok: false, code: "STOCK_NEGATIVE" });
    // An outflow from a batch (and from the no-batch row) that has no balance row yet.
    const c = await w.batch(v, "C");
    expect(await postAt(w, [{ variantId: v, batchId: c.id, qtyDelta: -1n }])).toMatchObject({ ok: false, code: "STOCK_NEGATIVE" });
    expect(await postAt(w, [{ variantId: v, qtyDelta: -1n }])).toMatchObject({ ok: false, code: "STOCK_NEGATIVE" });

    expect(await db.rtStockMovement.count()).toBe(before.movements);
    expect(await db.rtStockBalance.findMany({ orderBy: { id: "asc" } })).toEqual(before.balances);
  });

  it("20 concurrent outflows on the last unit let exactly one through", async () => {
    const w = await world();
    const v = w.variants[0]!;
    await postOk(w, [{ variantId: v, qtyDelta: U, valueDeltaMinor: 750n }]);
    const results = await Promise.all(Array.from({ length: 20 }, () => postAt(w, [{ variantId: v, qtyDelta: -U }])));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.code === "STOCK_NEGATIVE")).toHaveLength(19);
    expect(await balance(w, v)).toEqual({ qty: 0n, valueMinor: 0n });
    expect(await db.rtStockMovement.count()).toBe(2);
    expect((await rebuild(w, false)).mismatches).toEqual([]);
  });

  it("rebuildBalances matches the stored balances after 5000 random movements", async () => {
    const w = await world(3);
    const batches: (string | null)[][] = [];
    for (const v of w.variants) batches.push([null, (await w.batch(v, "A")).id, (await w.batch(v, "B")).id]);
    const random = rng(20261030);
    const pick = (n: number) => Math.floor(random() * n);
    const qty = new Map<string, bigint>(); // expected qty per (place, variant, batch)
    let count = 0;
    for (let call = 0; count < 5000; call++) {
      const p = call % 2;
      const moves: Move[] = [];
      for (let i = 0; i < 100 && count < 5000; i++, count++) {
        const vi = pick(w.variants.length);
        const batchId = batches[vi]![pick(3)]!;
        const key = `${p}|${vi}|${batchId}`;
        const have = qty.get(key) ?? 0n;
        if (have > 0n && random() < 0.45) {
          const out = BigInt(1 + pick(Number(have)));
          moves.push({ variantId: w.variants[vi]!, batchId, qtyDelta: -out });
          qty.set(key, have - out);
        } else {
          const inQty = BigInt(1 + pick(20_000));
          moves.push({ variantId: w.variants[vi]!, batchId, qtyDelta: inQty, valueDeltaMinor: BigInt(pick(50_000)) });
          qty.set(key, have + inQty);
        }
      }
      await postOk(w, moves, p);
    }
    expect(await db.rtStockMovement.count()).toBe(5000);
    expect((await rebuild(w, false)).mismatches).toEqual([]);
    // The base client works too (a maintenance script has no actor).
    expect((await rebuildBalances(db, w.businessId, { fix: false })).mismatches).toEqual([]);
    for (const [key, q] of qty) {
      const [p, vi, batchId] = key.split("|");
      const row = await balance(w, w.variants[Number(vi)]!, batchId === "null" ? null : batchId!, Number(p));
      expect(row?.qty).toBe(q);
    }
    // The per-variant total value is never negative.
    const totals = await db.rtStockBalance.groupBy({ by: ["locationId", "variantId"], _sum: { valueMinor: true } });
    for (const t of totals) expect(t._sum.valueMinor! >= 0n).toBe(true);
  }, 60_000);

  it("rebuildBalances finds and fixes a balance edited by hand", async () => {
    const w = await world(2);
    const [v1, v2] = w.variants as [string, string];
    const a = await w.batch(v1, "A");
    await postOk(w, [
      { variantId: v1, qtyDelta: 5n * U, valueDeltaMinor: 500n },
      { variantId: v1, batchId: a.id, qtyDelta: 4n * U, valueDeltaMinor: 900n },
      { variantId: v2, qtyDelta: 2n * U, valueDeltaMinor: 40n },
    ]);
    await postOk(w, [{ variantId: v1, qtyDelta: -1n * U }]);
    expect((await rebuild(w, false)).mismatches).toEqual([]);
    const loc = w.places[0]!.locationId;

    // Wrong numbers, a missing row and an extra row.
    await db.rtStockBalance.updateMany({ where: { locationId: loc, variantId: v1, batchId: null }, data: { qty: 77n } });
    await db.rtStockBalance.deleteMany({ where: { locationId: loc, variantId: v1, batchId: a.id } });
    await db.rtStockBalance.create({
      data: { businessId: w.businessId, branchId: w.places[1]!.branchId, locationId: w.places[1]!.locationId, variantId: v2, qty: 3n, valueMinor: 9n },
    });

    const found = await rebuild(w, false);
    expect(found.mismatches).toHaveLength(3);
    expect(found.mismatches).toEqual(
      expect.arrayContaining([
        { locationId: loc, variantId: v1, batchId: null, stored: { qty: 77n, valueMinor: 344n }, computed: { qty: 4n * U, valueMinor: 344n } },
        { locationId: loc, variantId: v1, batchId: a.id, stored: null, computed: { qty: 4n * U, valueMinor: 900n } },
        { locationId: w.places[1]!.locationId, variantId: v2, batchId: null, stored: { qty: 3n, valueMinor: 9n }, computed: null },
      ]),
    );
    // Without fix nothing changed.
    expect((await rebuild(w, false)).mismatches).toHaveLength(3);

    expect((await rebuild(w, true)).mismatches).toHaveLength(3);
    expect((await rebuild(w, false)).mismatches).toEqual([]);
    expect(await balance(w, v1)).toEqual({ qty: 4n * U, valueMinor: 344n });
    expect(await balance(w, v1, a.id)).toEqual({ qty: 4n * U, valueMinor: 900n });
    expect(await balance(w, v2, null, 1)).toBeNull();
  });

  it("1000 small outflows after a USD-rate receipt leave no value drift", async () => {
    const w = await world();
    const v = w.variants[0]!;
    const unit = { factor: 1, quantityScale: 0 };
    // 1000 pieces at $2.37 each, at 1311.37 IQD per USD.
    const value = convertMinor(lineValueMinor(237n, "1000", unit), "USD", "IQD", parseRate("1311.37"));
    expect(value).toBe(3_107_947n);
    await postOk(w, [{ variantId: v, qtyDelta: 1000n * U, valueDeltaMinor: value }]);
    for (let call = 0; call < 10; call++) {
      await postOk(w, Array.from({ length: 100 }, () => ({ variantId: v, qtyDelta: -U })));
    }
    expect(await balance(w, v)).toEqual({ qty: 0n, valueMinor: 0n });
    const outs = (await movementValues(w)).slice(1).map(([, val]) => -val!);
    expect(outs).toHaveLength(1000);
    expect(outs.reduce((s, x) => s + x, 0n)).toBe(value);
    // Every piece leaves at the receipt's unit cost (3107.947), give or take rounding.
    for (const x of outs) expect(x === 3107n || x === 3108n).toBe(true);
  }, 60_000);

  it("an outflow from a batch uses the variant average, not the batch cost", async () => {
    const w = await world();
    const v = w.variants[0]!;
    const cheap = await w.batch(v, "CHEAP");
    const dear = await w.batch(v, "DEAR");
    await postOk(w, [
      { variantId: v, batchId: cheap.id, qtyDelta: 10n * U, valueDeltaMinor: 1000n },
      { variantId: v, batchId: dear.id, qtyDelta: 10n * U, valueDeltaMinor: 3000n },
    ]);
    const loc = w.places[0]!.locationId;
    expect(await average({ locationId: loc, variantId: v }, w.meta())).toEqual({ ok: true, value: { qty: 20n * U, valueMinor: 4000n } });
    // 5 from the cheap batch leave at the average 200, not the batch's 100.
    await postOk(w, [{ variantId: v, batchId: cheap.id, qtyDelta: -5n * U }]);
    expect((await movementValues(w)).at(-1)).toEqual([-5n * U, -1000n]);
    expect(await balance(w, v, cheap.id)).toEqual({ qty: 5n * U, valueMinor: 0n });
    expect(await average({ locationId: loc, variantId: v }, w.meta())).toEqual({ ok: true, value: { qty: 15n * U, valueMinor: 3000n } });
    // Another location has its own average.
    await postOk(w, [{ variantId: v, batchId: cheap.id, qtyDelta: 1n * U, valueDeltaMinor: 50n }], 1);
    await postOk(w, [{ variantId: v, batchId: cheap.id, qtyDelta: -1n * U }], 1);
    expect((await movementValues(w)).at(-1)).toEqual([-1n * U, -50n]);
    expect((await rebuild(w, false)).mismatches).toEqual([]);
  });

  it("two businesses never touch each other's balances", async () => {
    const w1 = await world();
    const w2 = await world();
    const v1 = w1.variants[0]!;
    const v2 = w2.variants[0]!;
    await postOk(w1, [{ variantId: v1, qtyDelta: 5n * U, valueDeltaMinor: 500n }]);
    await postOk(w2, [{ variantId: v2, qtyDelta: 7n * U, valueDeltaMinor: 700n }]);
    const theirs = await db.rtStockBalance.findMany({ where: { businessId: w2.businessId } });
    const theirMovements = await db.rtStockMovement.count({ where: { businessId: w2.businessId } });

    // Business 1 posting at business 2's location and variant: refused, nothing written anywhere.
    const foreign = {
      documentId: w2.places[0]!.documentId,
      branchId: w2.places[0]!.branchId,
      locationId: w2.places[0]!.locationId,
      lines: [{ lineId: w2.places[0]!.lineOf[v2]!, variantId: v2, batchId: null, qtyDelta: -U }],
    };
    // An outflow sees no stock there (the scoped read finds none of business 2's rows).
    expect(await post(foreign, w1.meta())).toMatchObject({ ok: false, code: "STOCK_NEGATIVE" });
    // An inflow is refused by the database (the location's foreign key carries the businessId).
    await expect(
      post({ ...foreign, lines: [{ ...foreign.lines[0]!, qtyDelta: U, valueDeltaMinor: 1n }] }, w1.meta()),
    ).rejects.toThrow();
    // Through the ledger directly, a scoped client refuses a foreign businessId.
    await expect(
      db.$transaction((tx) => postMovements(scopedDb(w1.actor, tx), { businessId: w2.businessId, ...foreign }, async () => {})),
    ).rejects.toThrow();
    // Business 1 cannot read business 2's average.
    expect(await average({ locationId: w2.places[0]!.locationId, variantId: v2 }, w1.meta())).toEqual({
      ok: true,
      value: { qty: 0n, valueMinor: 0n },
    });
    expect(await db.rtStockBalance.findMany({ where: { businessId: w2.businessId } })).toEqual(theirs);
    expect(await db.rtStockMovement.count({ where: { businessId: w2.businessId } })).toBe(theirMovements);
    expect(await db.rtStockMovement.count({ where: { businessId: w1.businessId } })).toBe(1);

    // A rebuild with fix of business 1 neither reports nor repairs business 2's broken row.
    await db.rtStockBalance.updateMany({ where: { businessId: w2.businessId }, data: { qty: 1n } });
    expect((await rebuild(w1, true)).mismatches).toEqual([]);
    expect((await db.rtStockBalance.findFirstOrThrow({ where: { businessId: w2.businessId } })).qty).toBe(1n);
    expect((await rebuild(w2, false)).mismatches).toHaveLength(1);
  });

  it("reports the balance CHECK as STOCK_NEGATIVE when the in-memory check is bypassed", async () => {
    const w = await world();
    const v = w.variants[0]!;
    await postOk(w, [{ variantId: v, qtyDelta: U, valueDeltaMinor: 10n }]);
    const place = w.places[0]!;
    // A client whose balance read overstates the stock, so only the database CHECK can refuse.
    const attempt = db.$transaction(async (base) => {
      const tx = scopedDb(w.actor, base);
      const lying = {
        rtStockMovement: tx.rtStockMovement,
        rtVariant: tx.rtVariant,
        rtStockBalance: {
          ...tx.rtStockBalance,
          findMany: async (args: Parameters<typeof tx.rtStockBalance.findMany>[0]) =>
            (await tx.rtStockBalance.findMany(args)).map((r) => ("qty" in r ? { ...r, qty: 5n * U } : r)),
          createMany: tx.rtStockBalance.createMany,
          update: tx.rtStockBalance.update,
        },
      } as unknown as typeof tx;
      await postMovements(
        lying,
        { businessId: w.businessId, ...place, lines: [{ lineId: place.lineOf[v]!, variantId: v, batchId: null, qtyDelta: -2n * U }] },
        async () => {},
      );
    });
    await expect(attempt).rejects.toMatchObject({ name: "RuleError", code: "STOCK_NEGATIVE" });
    expect(await balance(w, v)).toEqual({ qty: U, valueMinor: 10n });
    expect(await db.rtStockMovement.count()).toBe(1);
  });

  it("refuses malformed lines before writing", async () => {
    const w = await world();
    const v = w.variants[0]!;
    const refuse = async (m: Move) => {
      const r = await postAt(w, [m]);
      expect(r).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    };
    await refuse({ variantId: v, qtyDelta: 0n });
    await refuse({ variantId: v, qtyDelta: U, valueDeltaMinor: -1n });
    // The ledger computes outflow values; a caller never passes one.
    await postOk(w, [{ variantId: v, qtyDelta: U, valueDeltaMinor: 10n }]);
    await refuse({ variantId: v, qtyDelta: -U, valueDeltaMinor: -10n });
    // Above MAX_BASE_QTY is a refusal, not a database overflow.
    await refuse({ variantId: v, qtyDelta: MAX_BASE_QTY + 1n });
    expect(await db.rtStockMovement.count()).toBe(1);
  });

  it("exactValues takes the caller's outflow values and still refuses a negative total", async () => {
    const w = await world();
    const v = w.variants[0]!;
    const a = await w.batch(v, "A");
    const b = await w.batch(v, "B");
    const exact = (moves: Move[]) => postAt(w, moves, 0, true);
    // Malformed: an outflow without a value or with a positive one, an inflow with a negative one.
    await postOk(w, [{ variantId: v, qtyDelta: 1n * U, valueDeltaMinor: 100n }]);
    for (const m of [
      { variantId: v, qtyDelta: -1n * U },
      { variantId: v, qtyDelta: -1n * U, valueDeltaMinor: 5n },
      { variantId: v, qtyDelta: 1n * U, valueDeltaMinor: -5n },
    ]) {
      expect(await exact([m])).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    }
    expect(await exact([{ variantId: v, qtyDelta: -1n * U, valueDeltaMinor: -100n }])).toMatchObject({ ok: true });

    // 10 at 100 on A and 10 at 300 on B; 10 leave A at the average 200, so A sits at qty 0 with
    // value -1000 and B at 10 / 3000: the variant has 10 worth 2000.
    await postOk(w, [
      { variantId: v, batchId: a.id, qtyDelta: 10n * U, valueDeltaMinor: 1000n },
      { variantId: v, batchId: b.id, qtyDelta: 10n * U, valueDeltaMinor: 3000n },
    ]);
    await postOk(w, [{ variantId: v, batchId: a.id, qtyDelta: -10n * U }]);
    expect(await balance(w, v, a.id)).toEqual({ qty: 0n, valueMinor: -1000n });
    const before = await db.rtStockMovement.count();
    // B's own row holds 3000, but the variant's total would drop to -1000: refused, nothing written.
    expect(await exact([{ variantId: v, batchId: b.id, qtyDelta: -10n * U, valueDeltaMinor: -3000n }])).toMatchObject({
      ok: false,
      code: "STOCK_NEGATIVE",
    });
    // The second line fails ONLY on the variant's total value (B keeps 9 of 10, then 8): the first
    // takes it to 500, the second to -100. Nothing of the call is written.
    const balancesBefore = await db.rtStockBalance.findMany({ orderBy: { id: "asc" } });
    expect(
      await exact([
        { variantId: v, batchId: b.id, qtyDelta: -1n * U, valueDeltaMinor: -1500n },
        { variantId: v, batchId: b.id, qtyDelta: -1n * U, valueDeltaMinor: -600n },
      ]),
    ).toMatchObject({ ok: false, code: "STOCK_NEGATIVE" });
    expect(await db.rtStockMovement.count()).toBe(before);
    expect(await db.rtStockBalance.findMany({ orderBy: { id: "asc" } })).toEqual(balancesBefore);
    // exactValues on a document that is not a REVERSAL (here the RECEIPT) is refused, nothing written.
    expect(await postAt(w, [{ variantId: v, batchId: b.id, qtyDelta: -1n * U, valueDeltaMinor: -100n }], 0, true, true)).toMatchObject({
      ok: false,
      code: "STOCK_RULE",
      details: { reason: "EXACT_VALUES_NOT_REVERSAL" },
    });
    expect(await db.rtStockMovement.count()).toBe(before);
    // A line that is fine followed by one that goes below zero: nothing of the call is kept.
    expect(
      await exact([
        { variantId: v, batchId: b.id, qtyDelta: -1n * U, valueDeltaMinor: -100n },
        { variantId: v, batchId: a.id, qtyDelta: -1n * U, valueDeltaMinor: -100n },
      ]),
    ).toMatchObject({ ok: false, code: "STOCK_NEGATIVE" });
    expect(await db.rtStockMovement.count()).toBe(before);
    // Within the total, the caller's values are written as given.
    expect(await exact([{ variantId: v, batchId: b.id, qtyDelta: -10n * U, valueDeltaMinor: -2000n }])).toMatchObject({ ok: true });
    expect((await movementValues(w)).at(-1)).toEqual([-10n * U, -2000n]);
    expect(await balance(w, v, b.id)).toEqual({ qty: 0n, valueMinor: 1000n });
    expect(await exact([{ variantId: v, batchId: a.id, qtyDelta: 5n * U, valueDeltaMinor: 777n }])).toMatchObject({ ok: true });
    expect(await average({ locationId: w.places[0]!.locationId, variantId: v }, w.meta())).toEqual({
      ok: true,
      value: { qty: 5n * U, valueMinor: 777n },
    });
    expect((await rebuild(w, false)).mismatches).toEqual([]);
  });

  it("isNegativeBalance never throws on an error whose meta JSON cannot carry", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(isNegativeBalance({ message: "boom", meta: { qty: 5n } })).toBe(false);
    expect(isNegativeBalance({ message: "x", meta: { constraint: "RtStockBalance_qty_nonneg", qty: 5n } })).toBe(true);
    expect(isNegativeBalance({ message: 'violates check constraint "RtStockBalance_qty_nonneg"', meta: cyclic })).toBe(true);
    expect(isNegativeBalance({ message: 7, meta: cyclic })).toBe(false);
  });
});
