import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineAction } from "@/server/framework/action";
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

  it("the stored result survives a round trip as JSON", async () => {
    const w = await world();
    const stamp = defineAction({
      name: "stamp",
      permission: null,
      input: z.object({}),
      writes: true,
      run: async () => ({ at: new Date("2026-01-02T03:04:05.000Z"), nested: { list: [1, "x", null] }, none: undefined }),
    });
    const first = await stamp({}, w.meta("owner", "k1"));
    const second = await stamp({}, w.meta("owner", "k1"));
    const expected = { at: "2026-01-02T03:04:05.000Z", nested: { list: [1, "x", null] } };
    expect(second).toEqual({ ok: true, value: expected });
    expect(first.ok).toBe(true);
    const row = await db.rtIdempotency.findFirstOrThrow();
    expect(row.result).toEqual({ value: expected });
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
