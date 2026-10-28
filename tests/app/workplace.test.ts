import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTestDb } from "../helpers/db";
import { createBusinessWithStaff, createPlan, createPlatformAdmin } from "../helpers/fixtures";

/*
 * The app-layer workplace code (cookie + session) with Next's request APIs replaced by an
 * in-memory cookie jar and a fixed session user; everything below them (scoped reads, the
 * provisioning action, the database) is real.
 */

const state = vi.hoisted(() => ({ jar: new Map<string, string>(), userId: null as string | null }));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (state.jar.has(name) ? { name, value: state.jar.get(name)! } : undefined),
    set: (name: string, value: string) => void state.jar.set(name, value),
    delete: (name: string) => void state.jar.delete(name),
  }),
  headers: async () => new Headers(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/auth/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/auth/auth")>()),
  getSessionUser: async () => (state.userId ? { id: state.userId, name: "User", email: "user@test" } : null),
  getSessionUserId: async () => state.userId,
}));

const { loadShell } = await import("@/app/retail/_shell");
const { selectWorkplace } = await import("@/app/retail/actions");
const { createBusiness } = await import("@/app/admin/actions");
const { WORKPLACE_COOKIE, encodeWorkplace } = await import("@/app/_lib/workplace");

const { db } = useTestDb();
const DAY = 86_400_000;

beforeEach(() => {
  state.jar.clear();
  state.userId = null;
});

async function live(businessId: string) {
  if (!(await db.rtPlan.findUnique({ where: { code: "basic" } }))) await createPlan(db);
  await db.rtSubscription.create({
    data: {
      businessId,
      planCode: "basic",
      status: "ACTIVE",
      currentPeriodStart: new Date(Date.now() - DAY),
      currentPeriodEnd: new Date(Date.now() + 30 * DAY),
    },
  });
}

/** A cashier of branch A in one business, and a second business with its own branch. */
async function world() {
  const shop = await createBusinessWithStaff(db, {
    branches: ["A", "B"],
    staff: [{ key: "cashier", role: "CASHIER", branches: ["A"] }],
  });
  const other = await createBusinessWithStaff(db, { branches: ["X"] });
  await live(shop.business.id);
  await live(other.business.id);
  const location = await db.rtLocation.create({
    data: { businessId: shop.business.id, branchId: shop.branches.B!.id, name: "B store" },
  });
  const terminalB = await db.rtTerminal.create({
    data: { businessId: shop.business.id, branchId: shop.branches.B!.id, locationId: location.id, name: "Till B" },
  });
  state.userId = shop.staff.cashier!.user.id;
  return { shop, other, terminalB };
}

function form(fields: Record<string, string>) {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.set(k, v);
  return data;
}

/** The URL a server action redirected to (Next throws a NEXT_REDIRECT error carrying it). */
async function redirectOf(run: Promise<unknown>): Promise<string> {
  const err = (await run.then(
    () => {
      throw new Error("expected a redirect");
    },
    (e: unknown) => e,
  )) as { digest?: string };
  if (typeof err?.digest !== "string" || !err.digest.startsWith("NEXT_REDIRECT")) throw err;
  return err.digest.split(";")[2]!;
}

describe("workplace cookie", () => {
  it("loadShell ignores a forged cookie naming another business's branch or a branch the user lacks", async () => {
    const { shop, other } = await world();

    state.jar.set(WORKPLACE_COOKIE, encodeWorkplace({ businessId: shop.business.id, branchId: other.branches.X!.id, terminalId: null }));
    let shell = await loadShell();
    expect(shell?.businessId).toBe(shop.business.id);
    expect(shell?.branch).toBeNull();

    state.jar.set(WORKPLACE_COOKIE, encodeWorkplace({ businessId: shop.business.id, branchId: shop.branches.B!.id, terminalId: null }));
    shell = await loadShell();
    expect(shell?.branch).toBeNull();
    expect(shell?.terminal).toBeNull();

    // The other business itself: the user is no member, so it is not even shown.
    state.jar.set(WORKPLACE_COOKIE, encodeWorkplace({ businessId: other.business.id, branchId: other.branches.X!.id, terminalId: null }));
    shell = await loadShell();
    expect(shell?.businessId).toBe(shop.business.id);
    expect(shell?.branch).toBeNull();

    state.jar.set(WORKPLACE_COOKIE, encodeWorkplace({ businessId: shop.business.id, branchId: shop.branches.A!.id, terminalId: null }));
    shell = await loadShell();
    expect(shell?.branch?.id).toBe(shop.branches.A!.id);
  });

  it("selectWorkplace refuses a branch or terminal the user does not have, and sets nothing", async () => {
    const { shop, other, terminalB } = await world();
    const refused = [
      { business: shop.business.id, branch: shop.branches.B!.id, terminal: "" },
      { business: shop.business.id, branch: other.branches.X!.id, terminal: "" },
      { business: shop.business.id, branch: shop.branches.A!.id, terminal: terminalB.id },
      { business: other.business.id, branch: other.branches.X!.id, terminal: "" },
    ];
    for (const fields of refused) {
      const to = await redirectOf(selectWorkplace(form(fields)));
      expect(to).toMatch(/^\/retail\/select\?error=FORBIDDEN/);
      expect(state.jar.has(WORKPLACE_COOKIE)).toBe(false);
    }

    const to = await redirectOf(selectWorkplace(form({ business: shop.business.id, branch: shop.branches.A!.id, terminal: "" })));
    expect(to).toBe("/retail/home");
    expect(state.jar.get(WORKPLACE_COOKIE)).toBe(`${shop.business.id}.${shop.branches.A!.id}.`);
  });
});

describe("create business form", () => {
  it("a resubmit of the same form with changed data is refused with IDEMPOTENCY_MISMATCH, not thrown", async () => {
    const admin = await createPlatformAdmin(db);
    await createPlan(db);
    state.userId = admin.id;
    const fields = {
      idempotencyKey: "form-key-1",
      name: "سوق الرافدين",
      activityType: "MARKET",
      branches: "المنصور\nالكرادة",
      ownerEmail: "owner@shop.test",
      defaultCurrency: "IQD",
      secondCurrency: "on",
      planCode: "basic",
      trialDays: "14",
    };
    expect(await createBusiness({ status: "idle" }, form(fields))).toMatchObject({ status: "created" });
    expect(await createBusiness({ status: "idle" }, form({ ...fields, name: "اسم آخر" }))).toEqual({
      status: "failed",
      code: "IDEMPOTENCY_MISMATCH",
    });
    expect(await db.rtBusiness.count()).toBe(1);
  });
});
