import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineAction } from "@/server/framework/action";
import { canonicalHash, decode, encode } from "@/server/framework/serialize";
import { NotFoundError } from "@/server/framework/errors";
import type { GateMode } from "@/server/framework/gate";
import { updateVersioned } from "@/server/framework/versioned";
import { useTestDb } from "../helpers/db";
import { createBusinessWithStaff } from "../helpers/fixtures";

// The gate is mocked so the tests control the mode; it answers FULL unless a test says otherwise.
const gateOf = vi.hoisted(() => vi.fn<(businessId: string, client: unknown) => Promise<GateMode>>());
vi.mock("@/server/framework/gate", () => ({ gateOf }));

const { db } = useTestDb();

afterEach(() => {
  vi.restoreAllMocks();
  gateOf.mockReset();
  gateOf.mockResolvedValue("FULL");
});
gateOf.mockResolvedValue("FULL");

// Test-only action. Permission "staff.manage": OWNER and MANAGER have it, CASHIER does not.
let runs = 0;
const renameBranch = defineAction({
  name: "branch.rename",
  permission: "staff.manage",
  input: z.object({ branchId: z.string(), name: z.string().min(1), expectedVersion: z.number().int() }),
  writes: true,
  async run({ tx, input }) {
    runs += 1;
    await updateVersioned(tx.rtBranch, { id: input.branchId }, input.expectedVersion, { name: input.name });
    const row = await tx.rtBranch.findUnique({ where: { id: input.branchId } });
    if (!row) throw new NotFoundError();
    return { id: row.id, name: row.name, version: row.version };
  },
  audit: (input) => ({ entity: "RtBranch", entityId: input.branchId, changes: { name: input.name } }),
});

const listBranches = defineAction({
  name: "branch.list",
  permission: null,
  input: z.object({}),
  writes: false,
  run: ({ tx }) => tx.rtBranch.findMany({ select: { name: true } }),
});

async function world() {
  const w = await createBusinessWithStaff(db, {
    branches: ["Main"],
    staff: [
      { key: "owner", role: "OWNER" },
      { key: "cashier", role: "CASHIER", branches: ["Main"] },
      { key: "gone", role: "OWNER", deactivated: true },
    ],
  });
  runs = 0;
  const meta = (who: string, key: string) => ({
    userId: w.staff[who]!.user.id,
    businessId: w.business.id,
    idempotencyKey: key,
  });
  return { ...w, branchId: w.branches.Main!.id, meta };
}

const counts = async () => ({
  audit: await db.rtAuditLog.count(),
  idem: await db.rtIdempotency.count(),
});

const ARABIC = /[؀-ۿ]/;

describe("defineAction", () => {
  it("refuses without permission and writes no audit row", async () => {
    const w = await world();
    const r = await renameBranch({ branchId: w.branchId, name: "X", expectedVersion: 1 }, w.meta("cashier", "k1"));
    expect(r).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect((r as { message: string }).message).toMatch(ARABIC);
    expect(runs).toBe(0);
    expect(await counts()).toEqual({ audit: 0, idem: 0 });
    expect((await db.rtBranch.findUnique({ where: { id: w.branchId } }))!.name).toBe("Main");
  });

  it("a deactivated actor and a non-member get FORBIDDEN", async () => {
    const w = await world();
    const input = { branchId: w.branchId, name: "X", expectedVersion: 1 };
    expect(await renameBranch(input, w.meta("gone", "k"))).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(await renameBranch(input, { ...w.meta("owner", "k"), userId: "nobody" })).toMatchObject({
      ok: false,
      code: "FORBIDDEN",
    });
    expect(await counts()).toEqual({ audit: 0, idem: 0 });
  });

  it("invalid input returns INVALID_INPUT without side effects", async () => {
    const w = await world();
    const r = await renameBranch({ branchId: w.branchId, name: "", expectedVersion: 1 }, w.meta("owner", "k"));
    expect(r).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(await renameBranch("nonsense", w.meta("owner", "k2"))).toMatchObject({ code: "INVALID_INPUT" });
    expect(runs).toBe(0);
    expect(await counts()).toEqual({ audit: 0, idem: 0 });
  });

  it("commits the change, one audit row and the idempotency result together", async () => {
    const w = await world();
    const r = await renameBranch({ branchId: w.branchId, name: "Central", expectedVersion: 1 }, w.meta("owner", "k1"));
    expect(r).toEqual({ ok: true, value: { id: w.branchId, name: "Central", version: 2 } });
    const audit = await db.rtAuditLog.findMany();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      businessId: w.business.id,
      actorId: w.staff.owner!.user.id,
      action: "branch.rename",
      entity: "RtBranch",
      entityId: w.branchId,
      changes: { name: "Central" },
    });
    expect(await db.rtIdempotency.count({ where: { scope: w.business.id, key: "k1" } })).toBe(1);
  });

  it("a repeated idempotencyKey with the same payload returns the stored result and runs once", async () => {
    const w = await world();
    const first = await renameBranch({ branchId: w.branchId, name: "Central", expectedVersion: 1 }, w.meta("owner", "k1"));
    // Same payload with the keys in another order: the canonical hash is the same.
    const second = await renameBranch(
      { expectedVersion: 1, name: "Central", branchId: w.branchId },
      w.meta("owner", "k1"),
    );
    expect(second).toEqual(first);
    expect(runs).toBe(1);
    expect(await counts()).toEqual({ audit: 1, idem: 1 });
    expect((await db.rtBranch.findUnique({ where: { id: w.branchId } }))!.version).toBe(2);
  });

  it("the same key with another payload returns IDEMPOTENCY_MISMATCH", async () => {
    const w = await world();
    await renameBranch({ branchId: w.branchId, name: "A", expectedVersion: 1 }, w.meta("owner", "k1"));
    const r = await renameBranch({ branchId: w.branchId, name: "B", expectedVersion: 2 }, w.meta("owner", "k1"));
    expect(r).toMatchObject({ ok: false, code: "IDEMPOTENCY_MISMATCH" });
    expect(runs).toBe(1);
    expect((await db.rtBranch.findUnique({ where: { id: w.branchId } }))!.name).toBe("A");
  });

  it("the audit row and the change commit together; if run throws neither exists", async () => {
    const w = await world();
    const failing = defineAction({
      name: "branch.renameThenFail",
      permission: "staff.manage",
      input: z.object({ branchId: z.string() }),
      writes: true,
      async run({ tx, input }) {
        await updateVersioned(tx.rtBranch, { id: input.branchId }, 1, { name: "Half done" });
        throw new Error("boom: secret internal detail");
      },
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const err = await failing({ branchId: w.branchId }, w.meta("owner", "k1")).then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).not.toContain("secret");
    expect(err!.message).toMatch(ARABIC);
    expect(logged).toHaveBeenCalled();
    expect((await db.rtBranch.findUnique({ where: { id: w.branchId } }))!.name).toBe("Main");
    expect(await counts()).toEqual({ audit: 0, idem: 0 });
    // The failed key is not burned: a retry with it can still run.
    const ok = await renameBranch({ branchId: w.branchId, name: "Retry", expectedVersion: 1 }, w.meta("owner", "k1"));
    expect(ok.ok).toBe(true);
  });

  it("a stale version returns VERSION_CONFLICT", async () => {
    const w = await world();
    await renameBranch({ branchId: w.branchId, name: "A", expectedVersion: 1 }, w.meta("owner", "k1"));
    const r = await renameBranch({ branchId: w.branchId, name: "B", expectedVersion: 1 }, w.meta("owner", "k2"));
    expect(r).toMatchObject({ ok: false, code: "VERSION_CONFLICT" });
    expect(await counts()).toEqual({ audit: 1, idem: 1 });
    expect((await db.rtBranch.findUnique({ where: { id: w.branchId } }))!.name).toBe("A");
  });

  it("maps NotFoundError to NOT_FOUND and rolls back", async () => {
    const w = await world();
    const gone = defineAction({
      name: "branch.find",
      permission: "staff.manage",
      input: z.object({}),
      writes: true,
      async run() {
        throw new NotFoundError();
      },
    });
    expect(await gone({}, w.meta("owner", "k1"))).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await counts()).toEqual({ audit: 0, idem: 0 });
  });

  it("idempotency keys are per business", async () => {
    const a = await world();
    const b = await world();
    const ra = await renameBranch({ branchId: a.branchId, name: "A", expectedVersion: 1 }, a.meta("owner", "same"));
    const rb = await renameBranch({ branchId: b.branchId, name: "B", expectedVersion: 1 }, b.meta("owner", "same"));
    expect(ra.ok && rb.ok).toBe(true);
    expect(await db.rtIdempotency.count()).toBe(2);
    // Another business's branch is invisible to the actor: the version never matches.
    const cross = await renameBranch({ branchId: b.branchId, name: "Z", expectedVersion: 2 }, a.meta("owner", "x"));
    expect(cross).toMatchObject({ ok: false, code: "VERSION_CONFLICT" });
  });

  it("two concurrent calls with the same key run exactly once", async () => {
    const w = await world();
    const input = { branchId: w.branchId, name: "Once", expectedVersion: 1 };
    const results = await Promise.all([
      renameBranch(input, w.meta("owner", "race")),
      renameBranch(input, w.meta("owner", "race")),
      renameBranch(input, w.meta("owner", "race")),
    ]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
    expect(runs).toBe(1);
    expect(await counts()).toEqual({ audit: 1, idem: 1 });
    expect((await db.rtBranch.findUnique({ where: { id: w.branchId } }))!.version).toBe(2);
  });

  it("a read action writes no audit or idempotency row and needs no key", async () => {
    const w = await world();
    const r = await listBranches({}, w.meta("cashier", ""));
    expect(r).toEqual({ ok: true, value: [{ name: "Main" }] });
    expect(await counts()).toEqual({ audit: 0, idem: 0 });
  });

  it("a write action without an idempotency key is INVALID_INPUT", async () => {
    const w = await world();
    const r = await renameBranch({ branchId: w.branchId, name: "X", expectedVersion: 1 }, w.meta("owner", ""));
    expect(r).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(runs).toBe(0);
  });

  it("the stored result survives a round trip: Dates come back as Dates", async () => {
    const w = await world();
    const at = new Date("2026-01-02T03:04:05.000Z");
    const stamp = defineAction({
      name: "stamp",
      permission: null,
      input: z.object({}),
      writes: true,
      run: async () => ({ at, nested: { list: [1, "x", null] }, none: undefined }),
    });
    const first = await stamp({}, w.meta("owner", "k1"));
    const second = await stamp({}, w.meta("owner", "k1"));
    expect(first).toEqual({ ok: true, value: { at, nested: { list: [1, "x", null] } } });
    expect(second).toEqual(first);
    expect((second as { value: { at: unknown } }).value.at).toBeInstanceOf(Date);
    const row = await db.rtIdempotency.findFirstOrThrow();
    expect(row.result).toEqual({ value: { at: { $date: "2026-01-02T03:04:05.000Z" }, nested: { list: [1, "x", null] } } });
  });

  it("the same key under another action returns IDEMPOTENCY_MISMATCH and the other action does not run", async () => {
    const w = await world();
    let otherRuns = 0;
    const other = defineAction({
      name: "branch.other",
      permission: "staff.manage",
      input: z.object({ branchId: z.string(), name: z.string().min(1), expectedVersion: z.number().int() }),
      writes: true,
      async run() {
        otherRuns += 1;
        return "other";
      },
    });
    const input = { branchId: w.branchId, name: "A", expectedVersion: 1 };
    const first = await renameBranch(input, w.meta("owner", "k1"));
    expect(await other(input, w.meta("owner", "k1"))).toMatchObject({ ok: false, code: "IDEMPOTENCY_MISMATCH" });
    expect(otherRuns).toBe(0);
    expect(await counts()).toEqual({ audit: 1, idem: 1 });
    expect(await renameBranch(input, w.meta("owner", "k1"))).toEqual(first);
  });

  it("the same key by another user of the same business returns IDEMPOTENCY_MISMATCH without leaking the result", async () => {
    const w = await createBusinessWithStaff(db, {
      branches: ["Main"],
      staff: [
        { key: "owner", role: "OWNER" },
        { key: "manager", role: "MANAGER" },
      ],
    });
    runs = 0;
    const branchId = w.branches.Main!.id;
    const meta = (who: string) => ({ userId: w.staff[who]!.user.id, businessId: w.business.id, idempotencyKey: "shared" });
    const input = { branchId, name: "Owner's", expectedVersion: 1 };
    expect(await renameBranch(input, meta("owner"))).toMatchObject({ ok: true });
    const r = await renameBranch(input, meta("manager"));
    expect(r).toMatchObject({ ok: false, code: "IDEMPOTENCY_MISMATCH" });
    expect(JSON.stringify(r)).not.toContain("Owner's");
    expect(runs).toBe(1);
  });
});

describe("serialization", () => {
  const echo = defineAction({
    name: "echo",
    permission: null,
    input: z.object({ amount: z.bigint().optional(), label: z.unknown().optional(), when: z.date().optional() }),
    writes: true,
    run: async ({ input }) => ({ amount: input.amount, when: input.when, tags: { $bigint: "7" } }),
    audit: (input) => ({ entity: "Echo", entityId: "1", changes: { amount: input.amount, when: input.when } }),
  });

  it("BigInt input works; in output it is a bigint on first run and on replay; audit changes store it", async () => {
    const w = await world();
    const when = new Date("2026-05-06T07:08:09.000Z");
    const first = await echo({ amount: 123456789012345678901n, when }, w.meta("owner", "k1"));
    const second = await echo({ amount: 123456789012345678901n, when }, w.meta("owner", "k1"));
    expect(first).toEqual({
      ok: true,
      value: { amount: 123456789012345678901n, when, tags: { $bigint: "7" } },
    });
    expect(second).toEqual(first);
    expect(typeof (second as { value: { amount: unknown } }).value.amount).toBe("bigint");
    // A user object shaped like a tag stays a plain object after replay.
    expect((second as { value: { tags: unknown } }).value.tags).toEqual({ $bigint: "7" });
    const audit = await db.rtAuditLog.findFirstOrThrow();
    expect(audit.changes).toEqual({
      amount: { $bigint: "123456789012345678901" },
      when: { $date: "2026-05-06T07:08:09.000Z" },
    });
    expect(decode(audit.changes)).toEqual({ amount: 123456789012345678901n, when });
  });

  it("hashes are stable and distinguish 1n, 2n, '1' and a tag-shaped object", async () => {
    const hash = (v: unknown) => canonicalHash({ input: v });
    expect(hash({ a: 1n, b: [1, { y: 2, x: 1 }] })).toBe(hash({ b: [1, { x: 1, y: 2 }], a: 1n }));
    expect(hash({ a: 1n })).not.toBe(hash({ a: 2n }));
    expect(hash({ a: 1n })).not.toBe(hash({ a: "1" }));
    expect(hash({ a: 1n })).not.toBe(hash({ a: 1 }));
    expect(hash({ a: 1n })).not.toBe(hash({ a: { $bigint: "1" } }));
    expect(hash({ a: new Date(0) })).not.toBe(hash({ a: { $date: new Date(0).toISOString() } }));
    expect(hash({ a: 1, b: undefined })).toBe(hash({ a: 1 }));
    expect(decode(encode({ $bigint: "1", $date: "x" }))).toEqual({ $bigint: "1", $date: "x" });
    expect(decode(encode({ $bigint: "1" }))).toEqual({ $bigint: "1" });
  });

  it("NaN, Infinity, Map and Set inputs are INVALID_INPUT without side effects", async () => {
    const w = await world();
    for (const label of [Number.NaN, Infinity, new Map(), new Set(), () => 1, Symbol("s")]) {
      const r = await echo({ label }, w.meta("owner", "k1"));
      expect(r, String(label)).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    }
    expect(await counts()).toEqual({ audit: 0, idem: 0 });
  });

  it("an output that cannot be serialized rolls back with an internal error", async () => {
    const w = await world();
    const bad = defineAction({
      name: "bad",
      permission: null,
      input: z.object({}),
      writes: true,
      run: async () => ({ m: new Map() }),
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(bad({}, w.meta("owner", "k1"))).rejects.toThrow(/[؀-ۿ]/);
    expect(await counts()).toEqual({ audit: 0, idem: 0 });
  });
});

describe("the gate", () => {
  it("READ_ONLY refuses writes but allows reads; CLOSED refuses both", async () => {
    const w = await world();
    const input = { branchId: w.branchId, name: "G", expectedVersion: 1 };

    gateOf.mockResolvedValue("READ_ONLY");
    expect(await renameBranch(input, w.meta("owner", "g1"))).toMatchObject({ ok: false, code: "READ_ONLY" });
    expect(await listBranches({}, w.meta("owner", ""))).toMatchObject({ ok: true });

    gateOf.mockResolvedValue("CLOSED");
    expect(await renameBranch(input, w.meta("owner", "g3"))).toMatchObject({ ok: false, code: "READ_ONLY" });
    expect(await listBranches({}, w.meta("owner", ""))).toMatchObject({ ok: false, code: "READ_ONLY" });
    expect(await counts()).toEqual({ audit: 0, idem: 0 });

    gateOf.mockResolvedValue("FULL");
    expect(await renameBranch(input, w.meta("owner", "g5"))).toMatchObject({ ok: true });
    expect(await counts()).toEqual({ audit: 1, idem: 1 });
  });
});
