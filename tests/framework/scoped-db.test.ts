import { describe, expect, it } from "vitest";
import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import { resolveActor, type Actor } from "@/server/framework/actor";
import {
  BRANCH_SCOPED_MODELS,
  BUSINESS_SCOPED_MODELS,
  NULLABLE_BUSINESS_MODELS,
  ScopeError,
  UNSCOPED_MODELS,
  PLATFORM_MANAGED_MODELS,
  classifyModels,
  modelFields,
  scopedDb,
} from "@/server/framework/scoped-db";
import { useTestDb } from "../helpers/db";
import { createBusinessWithStaff, createUser } from "../helpers/fixtures";

const { db } = useTestDb();

type Scoped = Prisma.TransactionClient;

/** Two businesses: "one" with branches A and B, "two" with branch X; one location per branch. */
async function world() {
  const one = await createBusinessWithStaff(db, {
    branches: ["A", "B"],
    staff: [
      { key: "cashier", role: "CASHIER", branches: ["A"] },
      { key: "owner", role: "OWNER" },
    ],
  });
  const two = await createBusinessWithStaff(db, { branches: ["X"], staff: [{ key: "owner", role: "OWNER" }] });
  const location = (businessId: string, branchId: string, name: string) =>
    db.rtLocation.create({ data: { businessId, branchId, name } });
  const locA = await location(one.business.id, one.branches.A!.id, "A-floor");
  const locB = await location(one.business.id, one.branches.B!.id, "B-floor");
  const locX = await location(two.business.id, two.branches.X!.id, "X-floor");
  const cashier: Actor = await resolveActor(one.staff.cashier!.user.id, one.business.id);
  const owner: Actor = await resolveActor(one.staff.owner!.user.id, one.business.id);
  const ownerTwo: Actor = await resolveActor(two.staff.owner!.user.id, two.business.id);
  return { one, two, locA, locB, locX, cashier, owner, ownerTwo };
}

async function expectScopeError(p: Promise<unknown>, code: string) {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ScopeError);
  expect(err).toMatchObject({ name: "ScopeError", code });
}

const modes: [string, <T>(actor: Actor, fn: (s: Scoped) => Promise<T>) => Promise<T>][] = [
  ["base client", (actor, fn) => fn(scopedDb(actor, db))],
  ["transaction client", (actor, fn) => db.$transaction((tx) => fn(scopedDb(actor, tx)))],
];

describe.each(modes)("scopedDb through the %s", (_mode, run) => {
  it("a cashier of branch A cannot read a location of branch B", async () => {
    const w = await world();
    expect(w.cashier.branchIds).toEqual([w.one.branches.A!.id]);
    await run(w.cashier, async (s) => {
      expect((await s.rtLocation.findMany()).map((l) => l.id)).toEqual([w.locA.id]);
      expect(await s.rtLocation.findUnique({ where: { id: w.locB.id } })).toBeNull();
      expect(await s.rtLocation.findFirst({ where: { id: w.locB.id } })).toBeNull();
      expect(await s.rtLocation.count()).toBe(1);
      expect((await s.rtBranch.findMany()).map((b) => b.id)).toEqual([w.one.branches.A!.id]);
      const grouped = await s.rtLocation.groupBy({ by: ["branchId"], _count: { _all: true } });
      expect(grouped).toEqual([{ branchId: w.one.branches.A!.id, _count: { _all: 1 } }]);
      const agg = await s.rtLocation.aggregate({ _count: { _all: true } });
      expect(agg._count._all).toBe(1);
    });
    await expect(
      run(w.cashier, (s) => s.rtLocation.findUniqueOrThrow({ where: { id: w.locB.id } })),
    ).rejects.toMatchObject({ code: "P2025" });
  });

  it("a user of business 1 reads nothing of business 2", async () => {
    const w = await world();
    // One person with staff rows in both businesses opens each in turn.
    const user = await createUser(db);
    await db.rtStaff.create({ data: { businessId: w.one.business.id, userId: user.id, role: "OWNER" } });
    await db.rtStaff.create({ data: { businessId: w.two.business.id, userId: user.id, role: "MANAGER" } });

    for (const [biz, other] of [
      [w.one, w.two],
      [w.two, w.one],
    ] as const) {
      const actor = await resolveActor(user.id, biz.business.id);
      await run(actor, async (s) => {
        const businesses = await s.rtBusiness.findMany();
        expect(businesses.map((b) => b.id)).toEqual([biz.business.id]);
        for (const rows of [
          await s.rtBranch.findMany(),
          await s.rtLocation.findMany(),
          await s.rtStaff.findMany(),
          await s.rtStaffBranch.findMany(),
          await s.rtTerminal.findMany(),
        ]) {
          for (const row of rows) expect(row.businessId).toBe(biz.business.id);
        }
        expect(await s.rtStaff.findMany({ where: { userId: user.id } })).toHaveLength(1);
        expect(await s.rtBusiness.findUnique({ where: { id: other.business.id } })).toBeNull();
        expect(await s.rtBranch.count({ where: { businessId: other.business.id } })).toBe(0);
      });
    }
  });

  it("create with a foreign branchId throws ScopeError", async () => {
    const w = await world();
    await expectScopeError(
      run(w.cashier, (s) =>
        s.rtLocation.create({ data: { businessId: w.one.business.id, branchId: w.one.branches.B!.id, name: "Sneaky" } }),
      ),
      "FOREIGN_BRANCH",
    );
    await expectScopeError(
      run(w.cashier, (s) =>
        s.rtLocation.createMany({
          data: [
            { businessId: w.one.business.id, branchId: w.one.branches.A!.id, name: "ok" },
            { businessId: w.one.business.id, branchId: w.one.branches.B!.id, name: "Sneaky" },
          ],
        }),
      ),
      "FOREIGN_BRANCH",
    );
    // A branch-limited actor cannot create a branch (its id cannot be among the actor's branches).
    await expectScopeError(
      run(w.cashier, (s) => s.rtBranch.create({ data: { businessId: w.one.business.id, name: "New" } })),
      "FOREIGN_BRANCH",
    );
    expect(await db.rtLocation.count({ where: { name: "Sneaky" } })).toBe(0);
    expect(await db.rtLocation.count({ where: { name: "ok" } })).toBe(0);
  });

  it("create forces the actor's businessId and refuses another one", async () => {
    const w = await world();
    await expectScopeError(
      run(w.owner, (s) =>
        s.rtLocation.create({ data: { businessId: w.two.business.id, branchId: w.two.branches.X!.id, name: "Cross" } }),
      ),
      "FOREIGN_BUSINESS",
    );
    const created = await run(w.cashier, (s) =>
      s.rtLocation.create({
        data: { branchId: w.one.branches.A!.id, name: "Forced" } as Prisma.RtLocationUncheckedCreateInput,
      }),
    );
    expect(created.businessId).toBe(w.one.business.id);
    // An ALL actor naming another business's branch is stopped by the composite foreign key.
    await expect(
      run(w.owner, (s) => s.rtLocation.create({ data: { businessId: w.one.business.id, branchId: w.two.branches.X!.id, name: "Cross" } })),
    ).rejects.toMatchObject({ code: "P2003" });
    await expectScopeError(
      run(w.owner, (s) =>
        s.rtBusiness.create({ data: { name: "Another", activityType: "MARKET", defaultCurrency: "IQD", enabledCurrencies: [] } }),
      ),
      "CREATE_NOT_ALLOWED",
    );
  });

  it("a caller OR cannot escape the scope filter", async () => {
    const w = await world();
    const rows = await run(w.cashier, (s) =>
      s.rtLocation.findMany({
        where: { OR: [{ id: w.locA.id }, { id: w.locB.id }, { id: w.locX.id }, { businessId: w.two.business.id }] },
      }),
    );
    expect(rows.map((r) => r.id)).toEqual([w.locA.id]);
    const notRows = await run(w.owner, (s) =>
      s.rtLocation.findMany({ where: { NOT: { businessId: w.one.business.id } } }),
    );
    expect(notRows).toEqual([]);
  });

  it("a caller-supplied where.businessId of another business returns nothing", async () => {
    const w = await world();
    await run(w.owner, async (s) => {
      expect(await s.rtLocation.findMany({ where: { businessId: w.two.business.id } })).toEqual([]);
      expect(await s.rtBranch.findFirst({ where: { businessId: w.two.business.id } })).toBeNull();
      expect(await s.rtLocation.count({ where: { businessId: w.two.business.id } })).toBe(0);
    });
  });

  it("update and delete of another business's or branch's row affect zero rows", async () => {
    const w = await world();
    await run(w.owner, async (s) => {
      expect(await s.rtLocation.updateMany({ where: { id: w.locX.id }, data: { name: "hacked" } })).toEqual({ count: 0 });
      expect(await s.rtLocation.deleteMany({ where: { id: w.locX.id } })).toEqual({ count: 0 });
      expect(await s.rtLocation.updateMany({ data: { name: "mine" } })).toEqual({ count: 2 });
    });
    await expect(
      run(w.owner, (s) => s.rtLocation.update({ where: { id: w.locX.id }, data: { name: "hacked" } })),
    ).rejects.toMatchObject({ code: "P2025" });
    await expect(run(w.owner, (s) => s.rtLocation.delete({ where: { id: w.locX.id } }))).rejects.toMatchObject({
      code: "P2025",
    });
    await run(w.cashier, async (s) => {
      expect(await s.rtLocation.updateMany({ where: { id: w.locB.id }, data: { name: "hacked" } })).toEqual({ count: 0 });
      expect(await s.rtLocation.deleteMany()).toEqual({ count: 1 });
    });
    // Upsert whose where names a foreign row never touches that row.
    await run(w.owner, (s) =>
      s.rtLocation.upsert({
        where: { id: w.locX.id },
        update: { name: "hacked" },
        create: { businessId: w.one.business.id, branchId: w.one.branches.A!.id, name: "upserted" },
      }),
    );
    expect((await db.rtLocation.findUniqueOrThrow({ where: { id: w.locX.id } })).name).toBe("X-floor");
    expect((await db.rtLocation.findUniqueOrThrow({ where: { id: w.locB.id } })).name).toBe("mine");
    expect(await db.rtLocation.count({ where: { id: w.locA.id } })).toBe(0);
  });

  it("moving a row to another branch or business via update data throws", async () => {
    const w = await world();
    await expectScopeError(
      run(w.cashier, (s) => s.rtLocation.update({ where: { id: w.locA.id }, data: { branchId: w.one.branches.B!.id } })),
      "FOREIGN_BRANCH",
    );
    await expectScopeError(
      run(w.cashier, (s) =>
        s.rtLocation.updateMany({ data: { branchId: { set: w.one.branches.B!.id } } }),
      ),
      "FOREIGN_BRANCH",
    );
    await expectScopeError(
      run(w.owner, (s) => s.rtLocation.update({ where: { id: w.locA.id }, data: { businessId: w.two.business.id } })),
      "FOREIGN_BUSINESS",
    );
    await expectScopeError(
      run(w.cashier, (s) =>
        s.rtLocation.upsert({
          where: { id: w.locA.id },
          update: { branchId: w.one.branches.B!.id },
          create: { businessId: w.one.business.id, branchId: w.one.branches.A!.id, name: "n" },
        }),
      ),
      "FOREIGN_BRANCH",
    );
    // An ALL actor may move a row between its own branches.
    const moved = await run(w.owner, (s) =>
      s.rtLocation.update({ where: { id: w.locA.id }, data: { branchId: w.one.branches.B!.id } }),
    );
    expect(moved.branchId).toBe(w.one.branches.B!.id);
  });

  it("nested writes are refused", async () => {
    const w = await world();
    // Inherited Object.prototype names are not fields of the model.
    await expectScopeError(
      run(w.owner, (s) =>
        s.rtLocation.create({
          data: { businessId: w.one.business.id, branchId: w.one.branches.A!.id, name: "L", toString: "x" } as never,
        }),
      ),
      "UNKNOWN_FIELD",
    );
    await expectScopeError(
      run(w.owner, (s) =>
        s.rtBranch.create({
          data: { businessId: w.one.business.id, name: "N", locations: { create: [{ name: "L", businessId: w.two.business.id }] } } as never,
        }),
      ),
      "NESTED_WRITE",
    );
    await expectScopeError(
      run(w.owner, (s) =>
        s.rtLocation.create({
          data: { name: "L", business: { connect: { id: w.one.business.id } }, branch: { connect: { id: w.one.branches.A!.id } } } as never,
        }),
      ),
      "NESTED_WRITE",
    );
    await expectScopeError(
      run(w.owner, (s) =>
        s.rtBranch.update({ where: { id: w.one.branches.A!.id }, data: { locations: { connect: { id: w.locX.id } } } }),
      ),
      "NESTED_WRITE",
    );
    await expectScopeError(
      run(w.owner, (s) =>
        s.rtStaff.update({ where: { id: w.one.staff.owner!.staffId }, data: { branches: { deleteMany: {} } } }),
      ),
      "NESTED_WRITE",
    );
  });

  it("include of a branch-scoped relation is refused for a branch-limited actor but allowed for an ALL actor", async () => {
    const w = await world();
    await expectScopeError(
      run(w.cashier, (s) => s.rtBusiness.findFirst({ include: { locations: true } })),
      "BRANCH_RELATION",
    );
    await expectScopeError(
      run(w.cashier, (s) => s.rtBusiness.findFirst({ select: { id: true, branches: { select: { id: true } } } })),
      "BRANCH_RELATION",
    );
    await expectScopeError(run(w.cashier, (s) => s.rtBusiness.findFirst({ include: { _count: true } })), "BRANCH_RELATION");
    await expectScopeError(
      run(w.cashier, (s) => s.rtStaff.findMany({ include: { business: { include: { terminals: true } } } })),
      "BRANCH_RELATION",
    );
    await expectScopeError(
      run(w.cashier, (s) => s.rtBusiness.findMany({ where: { locations: { some: { name: "B-floor" } } } })),
      "BRANCH_RELATION",
    );
    // Scalars and business-only relations stay allowed for the cashier.
    const staff = await run(w.cashier, (s) => s.rtStaff.findMany({ include: { business: true } }));
    expect(staff.every((r) => r.business.id === w.one.business.id)).toBe(true);

    const biz = await run(w.owner, (s) =>
      s.rtBusiness.findFirstOrThrow({ include: { locations: true, _count: { select: { branches: true } } } }),
    );
    expect(biz.locations.map((l) => l.id).sort()).toEqual([w.locA.id, w.locB.id].sort());
    expect(biz._count.branches).toBe(2);
  });

  it("relations into unscoped models are refused for every actor", async () => {
    const w = await world();
    await expectScopeError(run(w.owner, (s) => s.rtStaff.findMany({ include: { user: true } })), "UNSCOPED_RELATION");
    await expectScopeError(
      run(w.owner, (s) => s.rtStaff.findMany({ where: { user: { email: { contains: "@" } } } })),
      "UNSCOPED_RELATION",
    );
  });

  it("raw queries are refused", async () => {
    const w = await world();
    await expectScopeError(run(w.owner, (s) => s.$queryRaw`SELECT 1`), "RAW_QUERY");
    await expectScopeError(run(w.owner, (s) => s.$executeRaw`SELECT 1`), "RAW_QUERY");
    await expectScopeError(run(w.owner, (s) => s.$queryRawUnsafe("SELECT 1")), "RAW_QUERY");
    await expectScopeError(run(w.owner, (s) => s.$executeRawUnsafe("SELECT 1")), "RAW_QUERY");
  });

  it("unscoped models are never reachable", async () => {
    const w = await world();
    await expectScopeError(run(w.owner, (s) => s.user.findMany()), "UNSCOPED_MODEL");
    await expectScopeError(run(w.owner, (s) => s.session.findMany()), "UNSCOPED_MODEL");
    await expectScopeError(run(w.owner, (s) => s.account.count()), "UNSCOPED_MODEL");
    await expectScopeError(run(w.owner, (s) => s.verification.deleteMany()), "UNSCOPED_MODEL");
  });

  it("an ALL actor sees every branch of its own business and nothing of another", async () => {
    const w = await world();
    expect(w.owner.branchIds).toBe("ALL");
    await run(w.owner, async (s) => {
      expect((await s.rtBranch.findMany()).map((b) => b.id).sort()).toEqual(
        [w.one.branches.A!.id, w.one.branches.B!.id].sort(),
      );
      expect((await s.rtLocation.findMany()).map((l) => l.id).sort()).toEqual([w.locA.id, w.locB.id].sort());
      expect(await s.rtLocation.findUnique({ where: { id: w.locX.id } })).toBeNull();
    });
    await run(w.ownerTwo, async (s) => {
      expect((await s.rtLocation.findMany()).map((l) => l.id)).toEqual([w.locX.id]);
    });
  });
});

describe("scopedDb client behaviour", () => {
  it("works when handed a transaction client and inside its own transactions", async () => {
    const w = await world();
    const ids = await db.$transaction(async (tx) => {
      const s = scopedDb(w.cashier, tx);
      await s.rtLocation.create({ data: { businessId: w.one.business.id, branchId: w.one.branches.A!.id, name: "tx" } });
      return (await s.rtLocation.findMany()).map((l) => l.name).sort();
    });
    expect(ids).toEqual(["A-floor", "tx"]);

    const scoped = scopedDb(w.cashier, db);
    const viaInteractive = await scoped.$transaction(async (tx) => tx.rtLocation.findMany());
    expect(viaInteractive.map((l) => l.name).sort()).toEqual(["A-floor", "tx"]);
    const [viaBatch] = await scoped.$transaction([scoped.rtLocation.findMany()]);
    expect(viaBatch.map((l) => l.name).sort()).toEqual(["A-floor", "tx"]);
    await expectScopeError(scoped.$transaction(async (tx) => tx.$queryRaw`SELECT 1`), "RAW_QUERY");

    // A rejected scope check inside a handed-in transaction rolls the transaction back.
    await expect(
      db.$transaction(async (tx) => {
        const s = scopedDb(w.cashier, tx);
        await s.rtLocation.create({ data: { businessId: w.one.business.id, branchId: w.one.branches.A!.id, name: "rolled" } });
        await s.rtLocation.create({ data: { businessId: w.one.business.id, branchId: w.one.branches.B!.id, name: "rolled" } });
      }),
    ).rejects.toBeInstanceOf(ScopeError);
    expect(await db.rtLocation.count({ where: { name: "rolled" } })).toBe(0);
  });

  it("a transaction client wrapper refuses nested $transaction and other $ escapes", async () => {
    const w = await world();
    await db.$transaction(async (tx) => {
      const s = scopedDb(w.owner, tx) as unknown as Record<string, () => Promise<unknown>>;
      await expectScopeError(s.$transaction!(), "UNSUPPORTED_OPERATION");
      await expectScopeError(s.$queryRawTyped!(), "RAW_QUERY");
    });
  });

  it("the actor's branches are captured when the client is created", async () => {
    const w = await world();
    const actor: Actor = { ...w.cashier, branchIds: [...(w.cashier.branchIds as string[])] };
    const s = scopedDb(actor, db);
    (actor.branchIds as string[]).push(w.one.branches.B!.id);
    actor.businessId = w.two.business.id;
    expect((await s.rtLocation.findMany()).map((l) => l.id)).toEqual([w.locA.id]);
  });

  it("refuses a malformed actor", () => {
    expect(() => scopedDb({ userId: "u", businessId: "", role: "OWNER", branchIds: "ALL" }, db)).toThrow(ScopeError);
    expect(() =>
      scopedDb({ userId: "u", businessId: "b", role: "OWNER", branchIds: "SOME" as unknown as "ALL" }, db),
    ).toThrow(ScopeError);
  });

  it("defaults to the app's base client", () => {
    const s: PrismaClient = scopedDb({ userId: "u", businessId: "b", role: "OWNER", branchIds: "ALL" });
    expect(typeof s.rtLocation.findMany).toBe("function");
  });
});

const INTERNAL_KEYS = [
  "_appliedParent",
  "_originalClient",
  "_createItxClient",
  "_engine",
  "_request",
  "_executeRequest",
  "_runtimeDataModel",
  "$extends",
  "$connect",
  "$disconnect",
  "$on",
  "$use",
  "$parent",
  "then",
];

/** Inherited Object.prototype keys: outside the allow-list, so undefined on every surface and delegate. */
const PROTOTYPE_KEYS = [
  "constructor",
  "__proto__",
  "toString",
  "valueOf",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toLocaleString",
  "__lookupGetter__",
  "__lookupSetter__",
  "__defineGetter__",
  "__defineSetter__",
  "prototype",
];

/** Every way a surface could hand back an unscoped client: none may be reachable. */
async function expectNoEscape(surface: object, w: Awaited<ReturnType<typeof world>>) {
  const any = surface as Record<string | symbol, unknown>;
  for (const key of INTERNAL_KEYS) expect(any[key], key).toBeUndefined();
  for (const key of PROTOTYPE_KEYS) expect(any[key], key).toBeUndefined();
  for (const sym of Object.getOwnPropertySymbols(Object.getPrototypeOf(db) ?? {})) expect(any[sym]).toBeUndefined();
  expect(Object.keys(surface)).toEqual([]);
  expect(Reflect.ownKeys(surface)).toEqual([]);
  expect(Object.getPrototypeOf(surface)).toBeNull();
  expect("_appliedParent" in surface).toBe(false);
  expect(Object.getOwnPropertyDescriptor(surface, "_appliedParent")).toBeUndefined();
  // Delegates expose only the model operations.
  const delegate = any.rtLocation as Record<string, unknown>;
  for (const key of ["$parent", "$name", "fields", "_appliedParent", "constructor", "then"]) {
    expect(delegate[key], `rtLocation.${key}`).toBeUndefined();
  }
  for (const key of PROTOTYPE_KEYS) expect(delegate[key], `rtLocation.${key}`).toBeUndefined();
  expect(Reflect.ownKeys(delegate)).toEqual([]);
  // Every reachable property, recursively one level down, yields nothing of another business or branch.
  const s = surface as Scoped;
  expect((await s.rtLocation.findMany()).map((l) => l.id)).toEqual([w.locA.id]);
  expect(await s.rtBusiness.findUnique({ where: { id: w.two.business.id } })).toBeNull();
  await expectScopeError(s.user.findMany(), "UNSCOPED_MODEL");
  await expectScopeError(s.$queryRaw`SELECT 1`, "RAW_QUERY");
  expect(String(Object.prototype.toString.call(surface))).toBe("[object ScopedDb]");
}

describe("scopedDb exposes no escape hatch to the base client", () => {
  it("on scopedDb(actor)", async () => {
    const w = await world();
    const scoped = scopedDb(w.cashier, db);
    await expectNoEscape(scoped, w);
    expect((scoped as unknown as Record<string, unknown>)._appliedParent).not.toBe(db);
  });

  it("on scopedDb(actor, tx)", async () => {
    const w = await world();
    await db.$transaction(async (tx) => {
      await expectNoEscape(scopedDb(w.cashier, tx), w);
    });
  });

  it("on the tx inside scopedDb(actor).$transaction", async () => {
    const w = await world();
    await scopedDb(w.cashier, db).$transaction(async (tx) => {
      await expectNoEscape(tx, w);
      await expectScopeError((tx as unknown as { $transaction: () => Promise<unknown> }).$transaction(), "UNSUPPORTED_OPERATION");
    });
  });

  it("prints without crashing", async () => {
    const w = await world();
    const { inspect } = await import("node:util");
    // util.inspect shows the proxy's empty target, never the wrapped client.
    expect(inspect(scopedDb(w.cashier, db))).toBe("[Object: null prototype] {}");
    await db.$transaction(async (tx) => expect(inspect(scopedDb(w.cashier, tx))).toBe("[Object: null prototype] {}"));
    expect(() => expect(scopedDb(w.cashier, db)).toEqual({ nope: 1 })).toThrow();
  });

  it("an array $transaction with a ScopeError inside rolls back entirely", async () => {
    const w = await world();
    const s = scopedDb(w.cashier, db);
    const err = await s
      .$transaction([
        s.rtLocation.create({ data: { businessId: w.one.business.id, branchId: w.one.branches.A!.id, name: "batch" } }),
        s.rtLocation.create({ data: { businessId: w.one.business.id, branchId: w.one.branches.B!.id, name: "batch" } }),
      ])
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ScopeError);
    expect(err).toMatchObject({ code: "FOREIGN_BRANCH" });
    expect(await db.rtLocation.count({ where: { name: "batch" } })).toBe(0);
  });
});

describe("model classification", () => {
  it("every Rt model with a businessId column is listed as scoped", () => {
    const fields = modelFields();
    const models = Object.values(Prisma.ModelName);
    // The runtime data model must cover exactly the client's models (guards a Prisma upgrade).
    expect(Object.keys(fields).sort()).toEqual([...models].sort());

    expect(classifyModels(fields)).toEqual({ unclassified: [], misclassified: [] });
    for (const model of models) {
      const scalars = fields[model]!.scalars;
      if (model.startsWith("Rt") && scalars.includes("businessId")) {
        expect([...BUSINESS_SCOPED_MODELS, ...NULLABLE_BUSINESS_MODELS, ...PLATFORM_MANAGED_MODELS]).toContain(model);
      }
      if (BUSINESS_SCOPED_MODELS.includes(model) && scalars.includes("branchId")) {
        expect(BRANCH_SCOPED_MODELS).toContain(model);
      }
    }
    expect(UNSCOPED_MODELS).toEqual(expect.arrayContaining(["User", "Session", "Account", "Verification"]));
    // Subscription tables and owner invitations are platform-managed: unscoped (no tenant access)
    // although they carry a businessId.
    const platform = [
      "RtPlan",
      "RtSubscription",
      "RtSubscriptionEvent",
      "RtSubscriptionPayment",
      "RtFeatureOverride",
      "RtInvitation",
    ];
    expect(UNSCOPED_MODELS).toEqual(expect.arrayContaining([...platform, "RtPlatformAdmin"]));
    expect([...PLATFORM_MANAGED_MODELS].sort()).toEqual([...platform].sort());
    expect(BUSINESS_SCOPED_MODELS).toEqual(
      expect.arrayContaining(["RtBusiness", "RtBranch", "RtLocation", "RtTerminal", "RtStaff", "RtStaffBranch", "RtCapability"]),
    );
    expect([...BRANCH_SCOPED_MODELS].sort()).toEqual(["RtBranch", "RtLocation", "RtStaffBranch", "RtTerminal"]);
  });

  it("the classification check fails for an unlisted model", () => {
    const fields = {
      ...modelFields(),
      RtFuture: { scalars: ["id", "businessId", "branchId"], relations: {} },
      RtGlobalThing: { scalars: ["id"], relations: {} },
    };
    expect(classifyModels(fields).unclassified.sort()).toEqual(["RtFuture", "RtGlobalThing"]);
    // A business-scoped model that gains a branchId must also be listed as branch-scoped.
    const withBranch = { ...modelFields(), RtStaff: { scalars: ["id", "businessId", "branchId"], relations: {} } };
    expect(classifyModels(withBranch).misclassified).toEqual([
      "RtStaff: has a branchId column but is not branch-scoped",
    ]);
    // An unscoped model must not carry a businessId column (it belongs in NULLABLE_BUSINESS_MODELS instead).
    const authWithBusiness = { ...modelFields(), User: { scalars: ["id", "businessId"], relations: {} } };
    expect(classifyModels(authWithBusiness).misclassified).toEqual([
      "User: has a businessId column but is listed as unscoped",
    ]);
    // ...except the platform-managed tables, which are expressly allowed to.
    const platformWithBusiness = { ...modelFields(), RtSubscription: { scalars: ["id", "businessId"], relations: {} } };
    expect(classifyModels(platformWithBusiness).misclassified).toEqual([]);
  });
});
