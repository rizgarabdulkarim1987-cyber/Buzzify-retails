import { z } from "zod";
import type { Prisma, RtRole } from "@/generated/prisma/client";
import { ensureStaffIdentities } from "@/server/admin/core-identity";
import { emailSchema } from "@/server/admin/invitations";
import { DEFAULT_LOCATION_NAME, MAX_BRANCHES } from "@/server/admin/provision";
import { findUserIdsByEmail } from "@/server/auth/users";
import { can } from "@/server/domain/permissions";
import { ACTIVITY_TYPES, CAPABILITIES, validateCapabilities, type ActivityType, type Capability } from "@/server/domain/profiles";
import { defineAction, type ActionMeta, type Result } from "@/server/framework/action";
import type { Actor } from "@/server/framework/actor";
import { planBranchLimit } from "@/server/framework/business-info";
import { ForbiddenError, NotFoundError, RuleError } from "@/server/framework/errors";
import { updateVersioned } from "@/server/framework/versioned";

/*
 * The setup wizard: nine steps a new business walks through. R0 implements steps 1, 2, 3 and 5,
 * R1 step 4 (the catalog), R2 step 6 (opening stock); the others are shown as "soon", stay PENDING,
 * and completeSetupStep refuses them with STEP_NOT_AVAILABLE. Progress rows are created lazily: a
 * business with no rows reads as nine PENDING steps, and the first completed step inserts all nine.
 *
 * Step 4 follows the catalog itself (spec R1 7.15): it reads as DONE while the business has at least
 * one active product that is not a trial item (isTestData), or an import that is not a trial import
 * put at least one row into the catalog. Trial items never complete it: the point is a real catalog
 * before launch. completeSetupStep(4) checks the same condition (CATALOG_EMPTY otherwise) and
 * stores DONE, but the page always shows the live condition. Archiving every product reopens the
 * step only when it was completed by products alone: once a non-trial import has committed a row,
 * the step stays DONE for good (a committed import row is never deleted, even if its products are
 * archived later or a trial product it updated is removed).
 *
 * Step 6 (opening stock, spec R2 6ب.7) is OPTIONAL: it is never a condition for finishing setup.
 * It reads as DONE once the business has a POSTED OPENING document with a line of an item that is
 * not a trial item (entered by hand or imported); a posted document is never deleted, so this never
 * turns false. Until then it reads as its stored status: PENDING, or SKIPPED after
 * completeSetupStep({ step: 6, data: { skip: true } }) (the only thing step 6 accepts: completing it
 * is the posted opening itself). Trial items never complete it (they cannot hold stock anyway).
 *
 * Every step is an ordinary business action (permission staff.manage: OWNER and MANAGER), so it
 * is audited, idempotent by key, and refused while the business is READ_ONLY or CLOSED. Editing
 * existing rows (the business, a branch) is version-checked.
 */

type Tx = Prisma.TransactionClient;

export const SETUP_STEPS = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;
export type StepNumber = (typeof SETUP_STEPS)[number];
/** The steps this release can complete. */
export const AVAILABLE_STEPS = [1, 2, 3, 4, 5, 6] as const;
/** Available steps that setup does not need: they can be skipped (SKIPPED) and never block finishing. */
export const OPTIONAL_STEPS = [6] as const;
const SOON_STEPS = [7, 8, 9] as const;
const CATALOG_STEP = 4;
const OPENING_STEP = 6;

/** Stable keys (message keys in the UI). */
export const STEP_KEYS = {
  1: "business",
  2: "branches",
  3: "activity",
  4: "catalog",
  5: "staff",
  6: "openingStock",
  7: "devices",
  8: "payments",
  9: "launch",
} as const satisfies Record<StepNumber, string>;
export type StepKey = (typeof STEP_KEYS)[StepNumber];

export type SetupStatus = "PENDING" | "DONE" | "SKIPPED";
export type SetupStep = {
  step: StepNumber;
  key: StepKey;
  status: SetupStatus;
  /** False for the "soon" steps (not implemented in this release). */
  available: boolean;
  /** An optional step (OPTIONAL_STEPS): it can be skipped and is not needed to finish setup. */
  optional: boolean;
  isTestData: boolean;
  completedAt: Date | null;
};

export const CURRENCIES = ["IQD", "USD"] as const;
export const DEFAULT_TIMEZONE = "Asia/Baghdad";
/** Roles the wizard can give (never OWNER: ownership only comes through an owner invitation). */
export const STAFF_ROLES = ["MANAGER", "CASHIER", "STOCK", "PURCHASING", "ACCOUNTANT", "AUDITOR"] as const satisfies readonly RtRole[];
/** What a MANAGER may give; the other roles only the OWNER. */
export const MANAGER_GRANTABLE: readonly RtRole[] = ["CASHIER", "STOCK", "PURCHASING"];
export const MAX_STAFF_PER_SUBMIT = 50;

const unique = <T>(list: readonly T[]) => new Set(list).size === list.length;

/** True for an IANA time zone this runtime knows. */
export function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// Input

const id = z.string().min(1).max(64);
const version = z.number().int().min(1);
const branchName = z.string().trim().min(1).max(80);

const businessData = z
  .object({
    name: z.string().trim().min(1).max(120),
    defaultCurrency: z.enum(CURRENCIES),
    enabledCurrencies: z.array(z.enum(CURRENCIES)).min(1).max(2).refine(unique, "currencies must be unique"),
    timezone: z.string().trim().min(1).max(64).default(DEFAULT_TIMEZONE).refine(isTimeZone, "unknown time zone"),
    expectedVersion: version,
  })
  .strict()
  .refine((d) => d.enabledCurrencies.includes(d.defaultCurrency), "the default currency must be enabled");

const existingBranch = z.object({ id, name: branchName, expectedVersion: version }).strict();
const newBranch = z.object({ name: branchName, storeName: branchName.optional() }).strict();
const branchesData = z
  .object({
    branches: z
      .array(z.union([existingBranch, newBranch]))
      .max(MAX_BRANCHES)
      .refine((b) => unique(b.map((x) => x.name)), "branch names must be unique")
      .refine((b) => unique(b.flatMap((x) => ("id" in x ? [x.id] : []))), "branch ids must be unique"),
  })
  .strict();

const activityData = z
  .object({
    activityType: z.enum(ACTIVITY_TYPES),
    capabilities: z.array(z.enum(CAPABILITIES)).max(CAPABILITIES.length).refine(unique, "capabilities must be unique"),
    expectedVersion: version,
  })
  .strict();

const staffEntry = z
  .object({
    email: emailSchema,
    role: z.enum(STAFF_ROLES),
    branchIds: z.array(id).max(MAX_BRANCHES).refine(unique, "branch ids must be unique"),
    // Filled in by completeSetupStep from the email (never trusted from the caller).
    userId: z.string().min(1).nullable(),
  })
  .strict();
const staffData = z
  .object({
    staff: z
      .array(staffEntry)
      .max(MAX_STAFF_PER_SUBMIT)
      .refine((s) => unique(s.map((x) => x.email)), "emails must be unique"),
  })
  .strict();

const stepInput = z.discriminatedUnion("step", [
  z.object({ step: z.literal(1), data: businessData }).strict(),
  z.object({ step: z.literal(2), data: branchesData }).strict(),
  z.object({ step: z.literal(3), data: activityData }).strict(),
  z.object({ step: z.literal(4), data: z.object({}).strict().default({}) }).strict(),
  z.object({ step: z.literal(5), data: staffData }).strict(),
  z.object({ step: z.literal(6), data: z.object({ skip: z.literal(true) }).strict() }).strict(),
  z.object({ step: z.literal([...SOON_STEPS]), data: z.unknown() }).strict(),
]);
type StepInput = z.infer<typeof stepInput>;

// ---------------------------------------------------------------------------------------------
// Steps

async function saveBusiness(tx: Tx, actor: Actor, d: z.infer<typeof businessData>) {
  await updateVersioned(tx.rtBusiness, { id: actor.businessId }, d.expectedVersion, {
    name: d.name,
    defaultCurrency: d.defaultCurrency,
    enabledCurrencies: d.enabledCurrencies,
    timezone: d.timezone,
  });
}

async function saveBranches(tx: Tx, actor: Actor, d: z.infer<typeof branchesData>) {
  const { businessId } = actor;
  for (const b of d.branches) {
    if ("id" in b) {
      // Version-checked rename; another business's branch is out of scope and reads as a conflict.
      await updateVersioned(tx.rtBranch, { id: b.id, active: true }, b.expectedVersion, { name: b.name });
    } else {
      const row = await tx.rtBranch.create({ data: { businessId, name: b.name }, select: { id: true } });
      await tx.rtLocation.create({
        data: { businessId, branchId: row.id, name: b.storeName ?? DEFAULT_LOCATION_NAME, sellable: true, central: false },
      });
    }
  }
  // Names stay unique among the business's active branches.
  const names = (await tx.rtBranch.findMany({ where: { active: true }, select: { name: true } })).map((b) => b.name);
  if (!unique(names)) throw new RuleError("INVALID_INPUT");
  // Checked here, not in the precondition, so an idempotent replay of an earlier success is not refused.
  if (d.branches.some((b) => !("id" in b)) && names.length > (await planBranchLimit(businessId))) {
    throw new RuleError("PLAN_LIMIT");
  }
}

async function saveActivity(tx: Tx, actor: Actor, d: z.infer<typeof activityData>) {
  if (!validateCapabilities(d.capabilities).ok) throw new RuleError("CAPABILITY_CONFLICT");
  await updateVersioned(tx.rtBusiness, { id: actor.businessId }, d.expectedVersion, { activityType: d.activityType });
  const rows = await tx.rtCapability.findMany({ select: { capability: true, enabled: true } });
  const current = new Map(rows.map((r) => [r.capability, r.enabled]));
  for (const capability of CAPABILITIES) {
    const wanted = d.capabilities.includes(capability);
    const has = current.get(capability);
    if (has === undefined) {
      if (wanted) await tx.rtCapability.create({ data: { businessId: actor.businessId, capability, enabled: true } });
    } else if (has !== wanted) {
      await tx.rtCapability.updateMany({ where: { capability }, data: { enabled: wanted } });
    }
  }
}

async function saveStaff(tx: Tx, actor: Actor, d: z.infer<typeof staffData>) {
  for (const s of d.staff) {
    // A linked business may have just created this account from a Studio identity (after the ids were read).
    const userId = s.userId ?? (await findUserIdsByEmail([s.email])).get(s.email) ?? null;
    if (userId === null) throw new RuleError("USER_NOT_FOUND");
    if (actor.role !== "OWNER" && !MANAGER_GRANTABLE.includes(s.role)) throw new ForbiddenError("ROLE_NOT_GRANTABLE");
    // A branch-limited role needs at least one branch; multi-branch roles see every branch anyway.
    if (!can(s.role, "multiBranch.access") && s.branchIds.length === 0) throw new RuleError("INVALID_INPUT");
    const branches = await tx.rtBranch.findMany({ where: { id: { in: s.branchIds }, active: true }, select: { id: true } });
    if (branches.length !== s.branchIds.length) throw new NotFoundError();
    const member = await tx.rtStaff.findFirst({ where: { userId }, select: { id: true } });
    if (member) throw new RuleError("STAFF_EXISTS");

    const staff = await tx.rtStaff.create({ data: { businessId: actor.businessId, userId, role: s.role }, select: { id: true } });
    if (s.branchIds.length > 0) {
      await tx.rtStaffBranch.createMany({ data: s.branchIds.map((branchId) => ({ businessId: actor.businessId, staffId: staff.id, branchId })) });
    }
  }
}

/**
 * True when the catalog completes step 4: a real (not trial) active product right now, or, at any
 * time in the past, a real (non-trial) CATALOG import that committed a row (that part never turns
 * false; an opening-stock import does not count).
 */
async function catalogReady(tx: Tx): Promise<boolean> {
  const product = await tx.rtProduct.findFirst({ where: { archivedAt: null, isTestData: false }, select: { id: true } });
  if (product) return true;
  const imported = await tx.rtImportRow.findFirst({ where: { status: "COMMITTED", batch: { is: { isTestData: false, kind: "CATALOG" } } }, select: { id: true } });
  return imported !== null;
}

/**
 * When the opening stock completes step 6: the post time of the first POSTED OPENING document that
 * holds a line of an item that is not a trial item; null while there is none.
 */
async function openingStockDoneAt(tx: Tx): Promise<Date | null> {
  const doc = await tx.rtStockDocument.findFirst({
    where: { kind: "OPENING", status: "POSTED", lines: { some: { variant: { is: { product: { is: { isTestData: false } } } } } } },
    orderBy: [{ postedAt: "asc" }, { id: "asc" }],
    select: { postedAt: true },
  });
  return doc ? (doc.postedAt ?? new Date(0)) : null;
}

async function markStep(tx: Tx, actor: Actor, step: StepNumber, status: "DONE" | "SKIPPED") {
  await tx.rtSetupProgress.createMany({
    data: SETUP_STEPS.map((s) => ({ businessId: actor.businessId, step: s })),
    skipDuplicates: true });
  await tx.rtSetupProgress.updateMany({
    where: { step },
    // completedAt is set only for DONE (a check constraint): a skip is not a completion.
    data: { status, completedAt: status === "DONE" ? new Date() : null, version: { increment: 1 } },
  });
}

/** What the audit row keeps of a step: its data without internal fields. */
function auditData(input: StepInput): unknown {
  if (input.step === 5) return { staff: input.data.staff.map(({ email, role, branchIds }) => ({ email, role, branchIds })) };
  return input.data;
}

const completeStep = defineAction({
  name: "setup.step.complete",
  permission: "staff.manage",
  input: stepInput,
  writes: true,
  async precondition({ actor, input }) {
    if ((SOON_STEPS as readonly number[]).includes(input.step)) throw new RuleError("STEP_NOT_AVAILABLE");
    // Linked (Studio) businesses: ensure a Studio identity for each staff email and link it to the
    // local account before it is added. Runs after the permission check; a standalone business skips it.
    if (input.step === 5) await ensureStaffIdentities(actor.businessId, input.data.staff.map((s) => s.email));
  },
  async run({ actor, tx, input }): Promise<null> {
    switch (input.step) {
      case 1:
        await saveBusiness(tx, actor, input.data);
        break;
      case 2:
        await saveBranches(tx, actor, input.data);
        break;
      case 3:
        await saveActivity(tx, actor, input.data);
        break;
      case 4:
        if (!(await catalogReady(tx))) throw new RuleError("CATALOG_EMPTY");
        break;
      case 5:
        await saveStaff(tx, actor, input.data);
        break;
      case 6:
        // Optional: the only thing to send is a skip; it is DONE by itself once an opening is posted.
        await markStep(tx, actor, 6, "SKIPPED");
        return null;
      default:
        // Unreachable: the precondition refused it. Kept so a future step is never marked DONE by accident.
        throw new RuleError("STEP_NOT_AVAILABLE");
    }
    await markStep(tx, actor, input.step, "DONE");
    return null;
  },
  audit: (input) => ({ entity: "RtSetupProgress", entityId: String(input.step), changes: { step: input.step, data: auditData(input) } }),
});

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Completes (or re-saves) one wizard step for meta.businessId: `{ step, data }`.
 * - 1: `{ name, defaultCurrency, enabledCurrencies, timezone?, expectedVersion }` (the business's version)
 * - 2: `{ branches: [{ id, name, expectedVersion } | { name, storeName? }] }` (rename or add; a new branch gets one store)
 * - 3: `{ activityType, capabilities, expectedVersion }` (the business's version; replaces the enabled set)
 * - 4: `{}` (checks the catalog: CATALOG_EMPTY until a real product or a real import exists)
 * - 5: `{ staff: [{ email, role, branchIds }] }` (adds existing accounts as staff; may be empty)
 * - 6: `{ skip: true }` (optional step: marks it SKIPPED; it becomes DONE by itself with the first posted opening)
 * Steps 7, 8 and 9 return STEP_NOT_AVAILABLE. On success the value is null.
 */
export async function completeSetupStep(raw: unknown, meta: ActionMeta): Promise<Result<null>> {
  // Step 5 names people by email; the user id is resolved here (tenant code cannot read the User
  // table) and always overwrites anything the caller sent.
  if (isObject(raw) && raw.step === 5 && isObject(raw.data) && Array.isArray(raw.data.staff)) {
    const entries: unknown[] = raw.data.staff.slice(0, MAX_STAFF_PER_SUBMIT + 1);
    const emails = entries.flatMap((e) => (isObject(e) && typeof e.email === "string" ? [e.email] : []));
    const ids = await findUserIdsByEmail(emails);
    const staff = entries.map((e) =>
      isObject(e) ? { ...e, userId: typeof e.email === "string" ? (ids.get(e.email.trim().toLowerCase()) ?? null) : null } : e,
    );
    raw = { ...raw, data: { ...raw.data, staff } };
  }
  return completeStep(raw, meta);
}

// ---------------------------------------------------------------------------------------------
// Reads

/**
 * The nine steps with their stored status (PENDING when no row exists yet); step 4 with the
 * catalog's live status, step 6 DONE once an opening is posted (else its stored PENDING / SKIPPED).
 */
export const getSetupProgress = defineAction({
  name: "setup.progress",
  permission: "staff.manage",
  input: z.object({}),
  writes: false,
  async run({ tx }): Promise<SetupStep[]> {
    const rows = await tx.rtSetupProgress.findMany({ select: { step: true, status: true, isTestData: true, completedAt: true } });
    const byStep = new Map(rows.map((r) => [r.step, r]));
    const catalogDone = await catalogReady(tx);
    const openingAt = await openingStockDoneAt(tx);
    return SETUP_STEPS.map((step) => {
      const row = byStep.get(step);
      const stored: SetupStatus = row?.status ?? "PENDING";
      let status = stored;
      let completedAt = row?.completedAt ?? null;
      if (step === CATALOG_STEP) {
        status = catalogDone ? "DONE" : "PENDING";
        if (!catalogDone) completedAt = null;
      } else if (step === OPENING_STEP) {
        status = openingAt ? "DONE" : stored === "SKIPPED" ? "SKIPPED" : "PENDING";
        completedAt = openingAt;
      }
      return {
        step,
        key: STEP_KEYS[step],
        status,
        available: (AVAILABLE_STEPS as readonly number[]).includes(step),
        optional: (OPTIONAL_STEPS as readonly number[]).includes(step),
        isTestData: row?.isTestData ?? false,
        completedAt,
      };
    });
  },
});

export type SetupOverview = {
  business: {
    name: string;
    activityType: ActivityType;
    timezone: string;
    defaultCurrency: (typeof CURRENCIES)[number];
    enabledCurrencies: (typeof CURRENCIES)[number][];
    version: number;
  };
  capabilities: Capability[];
  branches: { id: string; name: string; version: number; stores: string[] }[];
  staff: { id: string; userId: string; role: RtRole; branchIds: string[] }[];
  /** Step 4: active products that count (not trial items), active trial items, and whether step 4 is complete. */
  catalog: { products: number; testProducts: number; ready: boolean };
};

/** What the wizard's forms show: the business, its enabled capabilities, branches with stores, and staff. */
export const setupOverview = defineAction({
  name: "setup.overview",
  permission: "staff.manage",
  input: z.object({}),
  writes: false,
  async run({ tx }): Promise<SetupOverview> {
    const business = await tx.rtBusiness.findFirstOrThrow({
      select: { name: true, activityType: true, timezone: true, defaultCurrency: true, enabledCurrencies: true, version: true },
    });
    const capabilities = (await tx.rtCapability.findMany({ where: { enabled: true }, select: { capability: true } })).map((c) => c.capability);
    const branches = await tx.rtBranch.findMany({
      where: { active: true },
      select: { id: true, name: true, version: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    const locations = await tx.rtLocation.findMany({
      where: { branchId: { in: branches.map((b) => b.id) } },
      select: { branchId: true, name: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    const staff = await tx.rtStaff.findMany({
      where: { deactivatedAt: null },
      select: { id: true, userId: true, role: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    const links = await tx.rtStaffBranch.findMany({ select: { staffId: true, branchId: true } });
    const catalog = {
      products: await tx.rtProduct.count({ where: { archivedAt: null, isTestData: false } }),
      testProducts: await tx.rtProduct.count({ where: { archivedAt: null, isTestData: true } }),
      ready: await catalogReady(tx),
    };
    return {
      catalog,
      business,
      capabilities: CAPABILITIES.filter((c) => capabilities.includes(c)),
      branches: branches.map((b) => ({ ...b, stores: locations.filter((l) => l.branchId === b.id).map((l) => l.name) })),
      staff: staff.map((s) => ({ ...s, branchIds: links.filter((l) => l.staffId === s.id).map((l) => l.branchId) })),
    };
  },
});
