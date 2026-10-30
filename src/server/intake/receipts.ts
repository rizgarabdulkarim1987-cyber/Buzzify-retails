import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { Currency, type RtIntakeStatus } from "@/generated/prisma/enums";
import { createMinimalProductInTx } from "@/server/catalog/products";
import { normalizeSearchText } from "@/server/domain/catalog";
import { INTAKE_MAX_BYTES, INTAKE_MAX_IMAGES, intakeFileHash } from "@/server/domain/intake";
import { can } from "@/server/domain/permissions";
import type { Actor } from "@/server/framework/actor";
import { defineAction, validKey, type ActionMeta } from "@/server/framework/action";
import { ForbiddenError, NotFoundError, RuleError, VersionConflictError, failure, type ErrorCode, type Result } from "@/server/framework/errors";
import { aiEnabledPrecondition } from "@/server/framework/features";
import { updateVersioned } from "@/server/framework/versioned";
import { createReceiptDraftInTx, type DraftLineInput } from "@/server/stock/documents";
import { businessOf } from "@/server/stock/posting";
import { assertConsent } from "./consent";
import {
  loadVariantInfo,
  matchReceipt,
  plainMoney,
  plainQuantity,
  priceFromTotal,
  reevaluate,
  type IntakeLine,
  type IntakeResult,
  type VariantInfo,
} from "./matching";
import { AiBadOutputError, AiUnavailableError, extractedReceiptSchema, getIntakeProvider, type ExtractedReceipt } from "./provider";
import { refundUnits, reserveUnits } from "./quota";

type Tx = Prisma.TransactionClient;

/*
 * Purchase-receipt intake (spec 3.1-3.18, 3ب, 8, 9): photos of a supplier's receipt become a
 * RECEIPT draft (saveStockDraft's own create path) after the reviewer has settled every line.
 * Nothing here posts stock, and nothing reaches the catalog without an explicit click.
 *
 * Access. Every action is behind the ai.intake master switch (aiEnabledPrecondition, re-checked
 * on every call including idempotent replays). Writes need ai.use + stock.receive + cost.view
 * (permission stock.receive, the other two in the precondition: FORBIDDEN); createIntakeItems
 * also catalog.manage. Reads need cost.view on every call. An intake is visible to its creator
 * and to holders of stock.adjust; anyone else (and any other business) gets NOT_FOUND. Page
 * bytes only through getIntakeImage, with the same checks.
 *
 * Flow and quota.
 * - createIntake validates the files BEFORE anything else (count, size, type sniffed from the
 *   bytes and equal to the declared type; INVALID_INPUT), then in one transaction: consent,
 *   retention cleanup, the duplicate check, reserveUnits (2 half units), the RtIntake (month and
 *   usageHalfUnits recorded on it) and its pages. The idempotency payload is the images' hash, so a
 *   retry with the same key replays without reserving again, and the same key with other images
 *   is IDEMPOTENCY_MISMATCH. The same images again (another key) are a new read: reserved again,
 *   and the answer carries duplicateOf (the latest earlier intake with the same hash within 90
 *   days that did not fail): a warning, not a refusal.
 * - runIntakeRead (an orchestrator, not one action; ruling R1b-A): a short step sets READING
 *   (switch, permissions, consent; without consent the intake FAILS with AI_CONSENT_REQUIRED and
 *   its reservation is refunded, no call is made); a read step loads the pages and re-checks switch
 *   and consent; the provider is called OUTSIDE any transaction with a timeout; a last short step
 *   stores the matched result (READ) or, on AI_UNAVAILABLE / AI_BAD_OUTPUT, FAILED plus the refund.
 *   A refund happens at most once per intake (refundedAt, set in the refund's transaction), so
 *   every path that answers AI_UNAVAILABLE / AI_BAD_OUTPUT has refunded. An empty reading (no
 *   lines) is INTAKE_NOT_READABLE: FAILED and NOT refunded (spec 3.10). A FAILED intake is never
 *   read again; a retry is a new intake (new reservation). A step refused by the switch leaves the
 *   intake as it was (READING stays READING; running again calls the provider again for the
 *   reservation already taken).
 * - The steps use internal idempotency keys of their own; the status machine under the intake's
 *   lock (`intake:<id>`) makes each step safe to repeat or race.
 * - resolveIntakeLine / setIntakeCurrency / createIntakeItems change RtIntake.result (version-
 *   checked, `intake:<id>` lock). createDraftFromIntake re-evaluates every line against the
 *   current catalog and refuses INTAKE_UNRESOLVED while a kept line is not MATCHED or the receipt
 *   currency is not chosen; then creates the draft through createReceiptDraftInTx (R2's checks:
 *   TEST_ITEM, SERIAL_NOT_SUPPORTED, ...) and records DRAFTED + stockDocumentId.
 * - stockDocumentId has no foreign key: it is resolved through the scoped client, and a missing
 *   document means the draft was deleted, so the intake counts as READ again (re-draft allowed).
 *
 * Locks: idempotency (framework) -> `intake:<id>` -> what the catalog/draft paths take (createProduct
 * without taxonomy takes none; the draft create path takes none; the SKU counter row last).
 *
 * Secrecy: answers and stored idempotency values carry ids, statuses and counts only (no prices);
 * prices live in RtIntake.result and are read through getIntake (cost.view). Audit rows hold ids
 * and counts.
 */

const RETENTION_DAYS = 30;
const RETENTION_BATCH = 20;
const DUPLICATE_DAYS = 90;
const DAY_MS = 86_400_000;
const READ_TIMEOUT_MS = 90_000;
export const MAX_NEW_ITEMS = 50;
const LIST_LIMIT = 50;
/** The base unit of a new item when the receipt names none (the catalog's quick-create default). */
const DEFAULT_BASE_UNIT = "قطعة";
const MAX_SUPPLIER_REF = 200;

const intakeLock = (id: string) => `intake:${id}`;

// ---------------------------------------------------------------------------------------------
// Access

/** ai.use + cost.view on top of the declared stock.receive, then the master switch. */
async function writePrecondition(ctx: { actor: Actor }): Promise<void> {
  if (!can(ctx.actor.role, "ai.use")) throw new ForbiddenError("ai.use");
  if (!can(ctx.actor.role, "cost.view")) throw new ForbiddenError("cost.view");
  await aiEnabledPrecondition(ctx);
}

async function itemsPrecondition(ctx: { actor: Actor }): Promise<void> {
  if (!can(ctx.actor.role, "catalog.manage")) throw new ForbiddenError("catalog.manage");
  await writePrecondition(ctx);
}

const visibleWhere = (actor: Actor): Prisma.RtIntakeWhereInput => (can(actor.role, "stock.adjust") ? {} : { createdById: actor.userId });

const intakeSelect = {
  id: true,
  status: true,
  createdById: true,
  filesHash: true,
  usageHalfUnits: true,
  month: true,
  result: true,
  failureCode: true,
  stockDocumentId: true,
  refundedAt: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} as const;

type IntakeRow = Prisma.RtIntakeGetPayload<{ select: typeof intakeSelect }>;

async function findIntake(tx: Tx, actor: Actor, intakeId: string): Promise<IntakeRow> {
  const row = await tx.rtIntake.findFirst({ where: { AND: [{ id: intakeId }, visibleWhere(actor)] }, select: intakeSelect });
  if (!row) throw new NotFoundError();
  return row;
}

/** Locks then reads the intake (NOT_FOUND when not visible). */
async function lockIntake(tx: Tx, actor: Actor, intakeId: string, lockBusiness: (name: string) => Promise<void>): Promise<IntakeRow> {
  await lockBusiness(intakeLock(intakeId));
  return findIntake(tx, actor, intakeId);
}

/** The status as the reviewer sees it: a DRAFTED intake whose draft no longer exists counts as READ. */
async function effectiveState(tx: Tx, row: IntakeRow): Promise<{ status: RtIntakeStatus; stockDocumentId: string | null }> {
  if (row.status !== "DRAFTED" || row.stockDocumentId === null) return { status: row.status, stockDocumentId: row.stockDocumentId };
  const doc = await tx.rtStockDocument.findFirst({ where: { id: row.stockDocumentId }, select: { id: true } });
  return doc ? { status: "DRAFTED", stockDocumentId: doc.id } : { status: "READ", stockDocumentId: null };
}

const KNOWN_FAILURES: readonly ErrorCode[] = ["AI_UNAVAILABLE", "AI_BAD_OUTPUT", "INTAKE_NOT_READABLE", "AI_CONSENT_REQUIRED"];
const failureOf = (code: string | null): ErrorCode => (KNOWN_FAILURES as readonly string[]).includes(code ?? "") ? (code as ErrorCode) : "AI_UNAVAILABLE";

/** Gives the intake's reservation back once (refundedAt guards it). Call under the intake lock. */
async function refundOnce(tx: Tx, actor: Actor, row: IntakeRow): Promise<boolean> {
  if (row.refundedAt !== null || row.month === null || row.usageHalfUnits <= 0) return false;
  await refundUnits(tx, { businessId: actor.businessId, month: row.month, halfUnits: row.usageHalfUnits });
  return true;
}

function resultOf(row: IntakeRow): IntakeResult {
  if (row.result === null || typeof row.result !== "object") throw new RuleError("INVALID_TRANSITION");
  return row.result as unknown as IntakeResult;
}

const asJson = (r: IntakeResult) => r as unknown as Prisma.InputJsonValue;

// ---------------------------------------------------------------------------------------------
// Upload validation (before anything is reserved)

const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp", "application/pdf"] as const;
type PageType = (typeof ALLOWED_TYPES)[number];

const startsWith = (b: Uint8Array, sig: number[], at = 0) => b.length >= at + sig.length && sig.every((v, i) => b[at + i] === v);

/** The type the bytes really are (magic numbers), or null for anything not allowed (GIF included). */
export function sniffPageType(b: Uint8Array): PageType | null {
  if (startsWith(b, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(b, [0x52, 0x49, 0x46, 0x46]) && startsWith(b, [0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
  if (startsWith(b, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf";
  return null;
}

const DECLARED_ALIASES: Record<string, PageType> = { "image/jpg": "image/jpeg", "image/pjpeg": "image/jpeg" };

const fileInput = z
  .object({ files: z.array(z.object({ contentType: z.string().max(100), bytes: z.instanceof(Uint8Array) }).strict()).min(1).max(INTAKE_MAX_IMAGES) })
  .strict();

type Page = { contentType: PageType; bytes: Uint8Array; sha256: string };

function validatePages(raw: unknown): Page[] | null {
  const parsed = fileInput.safeParse(raw);
  if (!parsed.success) return null;
  const pages: Page[] = [];
  for (const f of parsed.data.files) {
    if (f.bytes.byteLength === 0 || f.bytes.byteLength > INTAKE_MAX_BYTES) return null;
    const declared = f.contentType.trim().toLowerCase();
    const sniffed = sniffPageType(f.bytes);
    if (sniffed === null || (DECLARED_ALIASES[declared] ?? declared) !== sniffed) return null;
    pages.push({ contentType: sniffed, bytes: f.bytes, sha256: createHash("sha256").update(f.bytes).digest("hex") });
  }
  return pages;
}

// ---------------------------------------------------------------------------------------------
// createIntake

const createInput = z
  .object({
    filesHash: z.string().regex(/^[0-9a-f]{64}$/),
    pages: z
      .array(z.object({ position: z.number().int().min(1).max(INTAKE_MAX_IMAGES), contentType: z.enum(ALLOWED_TYPES), sha256: z.string().regex(/^[0-9a-f]{64}$/), size: z.number().int().min(1).max(INTAKE_MAX_BYTES) }).strict())
      .min(1)
      .max(INTAKE_MAX_IMAGES),
  })
  .strict();

function modelName(): string {
  if (process.env.NODE_ENV === "test" || process.env.INTAKE_PROVIDER === "fake") return "fake";
  return process.env.INTAKE_MODEL || "claude-sonnet-5-5";
}

/**
 * Deletes the stored pages of up to RETENTION_BATCH intakes of this business idle for over 30 days,
 * except an intake whose draft still exists unposted. The intake row (hash and result) stays.
 */
async function pruneExpiredPages(tx: Tx, now: Date): Promise<void> {
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * DAY_MS);
  const candidates = await tx.rtIntake.findMany({
    where: { updatedAt: { lt: cutoff }, files: { some: {} } },
    orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
    take: RETENTION_BATCH * 2,
    select: { id: true, status: true, stockDocumentId: true },
  });
  const docIds = candidates.flatMap((c) => (c.status === "DRAFTED" && c.stockDocumentId ? [c.stockDocumentId] : []));
  const pending = new Set(
    docIds.length ? (await tx.rtStockDocument.findMany({ where: { id: { in: docIds }, status: "DRAFT" }, select: { id: true } })).map((d) => d.id) : [],
  );
  const expired = candidates.filter((c) => !(c.status === "DRAFTED" && c.stockDocumentId && pending.has(c.stockDocumentId))).slice(0, RETENTION_BATCH);
  if (expired.length) await tx.rtIntakeFile.deleteMany({ where: { intakeId: { in: expired.map((c) => c.id) } } });
}

function createIntakeAction(pages: Page[]) {
  return defineAction({
    name: "intake.create",
    permission: "stock.receive",
    input: createInput,
    writes: true,
    timeoutMs: 30_000,
    precondition: writePrecondition,
    async run({ actor, tx, input }): Promise<{ intakeId: string; duplicateOf?: string }> {
      // The pages are bound to the hashed input (the idempotency payload).
      if (input.pages.length !== pages.length || input.pages.some((p, i) => p.sha256 !== pages[i]!.sha256 || p.position !== i + 1)) {
        throw new Error("createIntake: pages do not match the hashed input");
      }
      await assertConsent(tx, actor.businessId);
      const now = new Date();
      await pruneExpiredPages(tx, now);
      const earlier = await tx.rtIntake.findFirst({
        where: { filesHash: input.filesHash, status: { not: "FAILED" }, createdAt: { gte: new Date(now.getTime() - DUPLICATE_DAYS * DAY_MS) } },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: { id: true },
      });
      const { month } = await reserveUnits(tx, { businessId: actor.businessId, halfUnits: 2, now });
      const intake = await tx.rtIntake.create({
        data: { businessId: actor.businessId, createdById: actor.userId, filesHash: input.filesHash, model: modelName(), usageHalfUnits: 2, month },
        select: { id: true },
      });
      await tx.rtIntakeFile.createMany({
        data: pages.map((p, i) => ({
          businessId: actor.businessId,
          intakeId: intake.id,
          position: i + 1,
          contentType: p.contentType,
          bytes: new Uint8Array(p.bytes),
          sha256: p.sha256,
        })),
      });
      return earlier ? { intakeId: intake.id, duplicateOf: earlier.id } : { intakeId: intake.id };
    },
    audit: (input, value) => ({
      entity: "RtIntake",
      entityId: value.intakeId,
      changes: { pages: input.pages.length, duplicateOf: value.duplicateOf ?? null },
    }),
  });
}

/**
 * Uploads the pages of one receipt (1..6 JPEG/PNG/WebP/PDF files, each <= 8 MB, type sniffed from
 * the bytes) and reserves one read. `meta.idempotencyKey` is per submission attempt.
 */
export async function createIntake(raw: unknown, meta: ActionMeta): Promise<Result<{ intakeId: string; duplicateOf?: string }>> {
  const pages = validatePages(raw);
  if (!pages || !validKey(meta.idempotencyKey)) return failure("INVALID_INPUT");
  const filesHash = intakeFileHash(pages.map((p) => Buffer.from(p.bytes.buffer, p.bytes.byteOffset, p.bytes.byteLength)));
  const input = {
    filesHash,
    pages: pages.map((p, i) => ({ position: i + 1, contentType: p.contentType, sha256: p.sha256, size: p.bytes.byteLength })),
  };
  return createIntakeAction(pages)(input, meta);
}

// ---------------------------------------------------------------------------------------------
// runIntakeRead: its steps

const idInput = z.object({ intakeId: z.string().min(1).max(64) }).strict();

type StartState = { state: "READING" } | { state: "DONE"; status: RtIntakeStatus } | { state: "FAILED"; code: ErrorCode };

const startRead = defineAction({
  name: "intake.read.start",
  permission: "stock.receive",
  input: idInput,
  writes: true,
  precondition: writePrecondition,
  async run({ actor, tx, input, lockBusiness }): Promise<StartState> {
    const row = await lockIntake(tx, actor, input.intakeId, lockBusiness);
    if (row.status === "FAILED") return { state: "FAILED", code: failureOf(row.failureCode) };
    if (row.status !== "UPLOADED" && row.status !== "READING") return { state: "DONE", status: (await effectiveState(tx, row)).status };
    try {
      await assertConsent(tx, actor.businessId);
    } catch (err) {
      if (!(err instanceof RuleError)) throw err;
      // No consent: nothing is sent, the intake fails and its reservation goes back.
      const refunded = await refundOnce(tx, actor, row);
      await tx.rtIntake.updateMany({
        where: { id: row.id },
        data: { status: "FAILED", failureCode: "AI_CONSENT_REQUIRED", version: { increment: 1 }, ...(refunded ? { refundedAt: new Date() } : {}) },
      });
      return { state: "FAILED", code: "AI_CONSENT_REQUIRED" };
    }
    if (row.status === "UPLOADED") await tx.rtIntake.updateMany({ where: { id: row.id }, data: { status: "READING", version: { increment: 1 } } });
    return { state: "READING" };
  },
  audit: (input, value) => ({ entity: "RtIntake", entityId: input.intakeId, changes: { state: value.state } }),
});

/** The pages to send, when the intake is READING; re-checks the switch (precondition) and the consent just before the call. */
const loadPages = defineAction({
  name: "intake.read.pages",
  permission: "stock.receive",
  input: idInput,
  writes: false,
  timeoutMs: 20_000,
  precondition: writePrecondition,
  async run({ actor, tx, input }): Promise<{ status: RtIntakeStatus; failureCode: string | null; pages: { contentType: string; bytes: Uint8Array }[] }> {
    const row = await findIntake(tx, actor, input.intakeId);
    if (row.status !== "READING") return { status: row.status, failureCode: row.failureCode, pages: [] };
    await assertConsent(tx, actor.businessId);
    const files = await tx.rtIntakeFile.findMany({ where: { intakeId: row.id }, orderBy: { position: "asc" }, select: { contentType: true, bytes: true } });
    return { status: row.status, failureCode: null, pages: files.map((f) => ({ contentType: f.contentType, bytes: new Uint8Array(f.bytes) })) };
  },
});

type Outcome = { status: RtIntakeStatus; code?: ErrorCode };

const failRead = defineAction({
  name: "intake.read.fail",
  permission: "stock.receive",
  input: idInput.extend({ code: z.enum(["AI_UNAVAILABLE", "AI_BAD_OUTPUT"]) }).strict(),
  writes: true,
  precondition: writePrecondition,
  async run({ actor, tx, input, lockBusiness }): Promise<Outcome> {
    const row = await lockIntake(tx, actor, input.intakeId, lockBusiness);
    if (row.status === "FAILED") return { status: "FAILED", code: failureOf(row.failureCode) };
    if (row.status !== "READING") return { status: row.status };
    const refunded = await refundOnce(tx, actor, row);
    await tx.rtIntake.updateMany({
      where: { id: row.id },
      data: { status: "FAILED", failureCode: input.code, version: { increment: 1 }, ...(refunded ? { refundedAt: new Date() } : {}) },
    });
    return { status: "FAILED", code: input.code };
  },
  audit: (input, value) => ({ entity: "RtIntake", entityId: input.intakeId, changes: { status: value.status, code: value.code ?? null } }),
});

const storeRead = defineAction({
  name: "intake.read.store",
  permission: "stock.receive",
  input: idInput.extend({ extracted: extractedReceiptSchema }).strict(),
  writes: true,
  timeoutMs: 30_000,
  precondition: writePrecondition,
  async run({ actor, tx, input, lockBusiness }): Promise<Outcome & { lines: number }> {
    const row = await lockIntake(tx, actor, input.intakeId, lockBusiness);
    if (row.status === "FAILED") return { status: "FAILED", code: failureOf(row.failureCode), lines: 0 };
    if (row.status !== "READING") return { status: row.status, lines: 0 };
    if (input.extracted.lines.length === 0) {
      // A valid answer with nothing in it: not a technical failure, so not refunded (spec 3.10).
      await tx.rtIntake.updateMany({ where: { id: row.id }, data: { status: "FAILED", failureCode: "INTAKE_NOT_READABLE", version: { increment: 1 } } });
      return { status: "FAILED", code: "INTAKE_NOT_READABLE", lines: 0 };
    }
    const result = await matchReceipt(tx, input.extracted, await businessOf(tx));
    await tx.rtIntake.updateMany({ where: { id: row.id }, data: { status: "READ", result: asJson(result), version: { increment: 1 } } });
    return { status: "READ", lines: result.lines.length };
  },
  audit: (input, value) => ({ entity: "RtIntake", entityId: input.intakeId, changes: { status: value.status, lines: value.lines } }),
});

const stepMeta = (meta: ActionMeta, step: string): ActionMeta => ({ ...meta, idempotencyKey: `intake-read:${step}:${randomUUID()}` });

const doneOrFailed = (intakeId: string, o: Outcome): Result<{ intakeId: string; status: RtIntakeStatus }> =>
  o.status === "FAILED" ? failure(o.code ?? "AI_UNAVAILABLE") : { ok: true, value: { intakeId, status: o.status } };

/**
 * Reads an uploaded intake with the AI provider (see the file comment). Ok with the intake's
 * status (READ, or DRAFTED/DISCARDED when already past reading); a failed reading answers its code.
 */
export async function runIntakeRead(raw: unknown, meta: ActionMeta): Promise<Result<{ intakeId: string; status: RtIntakeStatus }>> {
  const parsed = idInput.safeParse(raw);
  if (!parsed.success || !validKey(meta.idempotencyKey)) return failure("INVALID_INPUT");
  const { intakeId } = parsed.data;

  const started = await startRead({ intakeId }, stepMeta(meta, "start"));
  if (!started.ok) return started;
  const s = started.value;
  if (s.state === "FAILED") return failure(s.code);
  if (s.state === "DONE") return { ok: true, value: { intakeId, status: s.status } };

  const loaded = await loadPages({ intakeId }, meta);
  if (!loaded.ok) return loaded;
  if (loaded.value.status !== "READING") {
    return doneOrFailed(intakeId, { status: loaded.value.status, code: failureOf(loaded.value.failureCode) });
  }

  let extracted: ExtractedReceipt;
  try {
    extracted = await getIntakeProvider().readReceipt(loaded.value.pages, { signal: AbortSignal.timeout(READ_TIMEOUT_MS) });
  } catch (err) {
    if (!(err instanceof AiUnavailableError) && !(err instanceof AiBadOutputError)) console.error("[intake.read] provider failed unexpectedly", err);
    const code = err instanceof AiBadOutputError ? "AI_BAD_OUTPUT" : "AI_UNAVAILABLE";
    const failed = await failRead({ intakeId, code }, stepMeta(meta, "fail"));
    return failed.ok ? doneOrFailed(intakeId, failed.value) : failed;
  }

  const stored = await storeRead({ intakeId, extracted }, stepMeta(meta, "store"));
  return stored.ok ? doneOrFailed(intakeId, stored.value) : stored;
}

// ---------------------------------------------------------------------------------------------
// Reads

export type IntakeView = {
  id: string;
  status: RtIntakeStatus;
  createdAt: Date;
  createdById: string;
  failureCode: string | null;
  version: number;
  /** Pages still stored (0 once the retention policy removed them). */
  pageCount: number;
  /** An earlier intake of the same images (90 days, not failed). */
  duplicateOf: string | null;
  /** The live draft made from it; null when none or deleted. */
  stockDocumentId: string | null;
  result: IntakeResult | null;
};

/** One intake with its reading (prices included: cost.view is required). */
export const getIntake = defineAction({
  name: "intake.get",
  permission: "cost.view",
  input: idInput,
  writes: false,
  precondition: aiEnabledPrecondition,
  async run({ actor, tx, input }): Promise<IntakeView> {
    const row = await findIntake(tx, actor, input.intakeId);
    const state = await effectiveState(tx, row);
    const pageCount = await tx.rtIntakeFile.count({ where: { intakeId: row.id } });
    const earlier = await tx.rtIntake.findFirst({
      where: {
        filesHash: row.filesHash,
        id: { not: row.id },
        status: { not: "FAILED" },
        createdAt: { lte: row.createdAt, gte: new Date(row.createdAt.getTime() - DUPLICATE_DAYS * DAY_MS) },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { id: true },
    });
    return {
      id: row.id,
      status: state.status,
      createdAt: row.createdAt,
      createdById: row.createdById,
      failureCode: row.failureCode,
      version: row.version,
      pageCount,
      duplicateOf: earlier?.id ?? null,
      stockDocumentId: state.stockDocumentId,
      result: row.result === null ? null : (row.result as unknown as IntakeResult),
    };
  },
});

export type IntakeListRow = { id: string; status: RtIntakeStatus; createdAt: Date; failureCode: string | null; supplier: string | null; lineCount: number };

/** The caller's visible intakes, newest first (no prices). */
export const listIntakes = defineAction({
  name: "intake.list",
  permission: "cost.view",
  input: z.object({ cursor: z.string().min(1).max(64).optional(), limit: z.number().int().min(1).max(LIST_LIMIT).default(20) }).strict(),
  writes: false,
  precondition: aiEnabledPrecondition,
  async run({ actor, tx, input }): Promise<{ rows: IntakeListRow[]; nextCursor: string | null }> {
    const where: Prisma.RtIntakeWhereInput[] = [visibleWhere(actor)];
    if (input.cursor) {
      const at = await tx.rtIntake.findFirst({ where: { AND: [{ id: input.cursor }, visibleWhere(actor)] }, select: { id: true, createdAt: true } });
      if (!at) throw new NotFoundError();
      where.push({ OR: [{ createdAt: { lt: at.createdAt } }, { createdAt: at.createdAt, id: { lt: at.id } }] });
    }
    const found = await tx.rtIntake.findMany({
      where: { AND: where },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: input.limit + 1,
      select: { id: true, status: true, createdAt: true, failureCode: true, result: true },
    });
    const page = found.slice(0, input.limit);
    return {
      rows: page.map((r) => {
        const result = r.result as unknown as IntakeResult | null;
        return {
          id: r.id,
          status: r.status,
          createdAt: r.createdAt,
          failureCode: r.failureCode,
          supplier: result?.supplier ?? null,
          lineCount: result?.lines.length ?? 0,
        };
      }),
      nextCursor: found.length > input.limit ? page[page.length - 1]!.id : null,
    };
  },
});

/** The bytes of one stored page (1-based position); NOT_FOUND once retention removed it. */
export const getIntakeImage = defineAction({
  name: "intake.image",
  permission: "cost.view",
  input: idInput.extend({ position: z.number().int().min(1).max(INTAKE_MAX_IMAGES) }).strict(),
  writes: false,
  timeoutMs: 20_000,
  precondition: aiEnabledPrecondition,
  async run({ actor, tx, input }): Promise<{ contentType: string; bytes: Uint8Array }> {
    const row = await findIntake(tx, actor, input.intakeId);
    const file = await tx.rtIntakeFile.findFirst({ where: { intakeId: row.id, position: input.position }, select: { contentType: true, bytes: true } });
    if (!file) throw new NotFoundError();
    return { contentType: file.contentType, bytes: new Uint8Array(file.bytes) };
  },
});

// ---------------------------------------------------------------------------------------------
// Review

const version = z.number().int().min(1);
const id = z.string().min(1).max(64);

/** Locks the intake, checks the version and that it is in review (READ, or DRAFTED with its draft deleted). */
async function openForReview(tx: Tx, actor: Actor, intakeId: string, expectedVersion: number, lockBusiness: (name: string) => Promise<void>) {
  const row = await lockIntake(tx, actor, intakeId, lockBusiness);
  if (row.version !== expectedVersion) throw new VersionConflictError();
  const state = await effectiveState(tx, row);
  return { row, state };
}

function assertInReview(state: { status: RtIntakeStatus }): void {
  if (state.status !== "READ") throw new RuleError("INVALID_TRANSITION");
}

async function saveResult(tx: Tx, row: IntakeRow, result: IntakeResult, extra: Record<string, unknown> = {}) {
  await updateVersioned(tx.rtIntake, { id: row.id }, row.version, { result: asJson(result), ...extra });
}

const lineAction = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("PICK_ITEM"), variantId: id, unitId: id }).strict(),
  z.object({ kind: z.literal("PICK_UNIT"), unitId: id }).strict(),
  z.object({ kind: z.literal("USE_TOTAL_DIV_QTY") }).strict(),
  z.object({ kind: z.literal("DISCARD") }).strict(),
]);

const BARCODE_NOTES = new Set(["BARCODE_IGNORED", "BARCODE_CHECKSUM"]);

/** The variant a reviewer may pick: as R2 refuses it on a receipt (TEST_ITEM, SERIAL_NOT_SUPPORTED, archived). */
function assertPickable(info: VariantInfo | undefined, lineNo: number): VariantInfo {
  if (!info) throw new NotFoundError();
  if (info.isTestData) throw new RuleError("TEST_ITEM", { lineNo: String(lineNo) });
  if (info.trackingMode === "SERIAL") throw new RuleError("SERIAL_NOT_SUPPORTED", { lineNo: String(lineNo) });
  if (info.archived) throw new RuleError("STOCK_RULE", { lineNo: String(lineNo), reason: "ARCHIVED" });
  return info;
}

/** Settles one line: pick the item and unit, pick the unit, take the price from the line total, or discard it. */
export const resolveIntakeLine = defineAction({
  name: "intake.line.resolve",
  permission: "stock.receive",
  input: z.object({ intakeId: id, lineNo: z.number().int().min(1).max(1000), action: lineAction, expectedVersion: version }).strict(),
  writes: true,
  precondition: writePrecondition,
  async run({ actor, tx, input, lockBusiness }): Promise<{ intakeId: string; version: number }> {
    const { row, state } = await openForReview(tx, actor, input.intakeId, input.expectedVersion, lockBusiness);
    assertInReview(state);
    const result = resultOf(row);
    const line = result.lines.find((l) => l.lineNo === input.lineNo);
    if (!line) throw new NotFoundError();
    if (line.discarded && input.action.kind !== "DISCARD") throw new RuleError("INVALID_TRANSITION");

    let next: IntakeLine;
    const a = input.action;
    switch (a.kind) {
      case "PICK_ITEM": {
        const info = assertPickable((await loadVariantInfo(tx, [a.variantId])).get(a.variantId), line.lineNo);
        if (!info.units.some((u) => u.id === a.unitId)) throw new RuleError("STOCK_RULE", { lineNo: String(line.lineNo), reason: "UNIT_NOT_OF_VARIANT" });
        next = {
          ...line,
          variantId: info.id,
          unitId: a.unitId,
          source: "REVIEWER",
          confirmed: true,
          candidates: undefined,
          notes: line.notes.filter((n) => BARCODE_NOTES.has(n)),
        };
        break;
      }
      case "PICK_UNIT": {
        if (!line.variantId) throw new RuleError("INVALID_TRANSITION");
        const info = assertPickable((await loadVariantInfo(tx, [line.variantId])).get(line.variantId), line.lineNo);
        if (!info.units.some((u) => u.id === a.unitId)) throw new RuleError("STOCK_RULE", { lineNo: String(line.lineNo), reason: "UNIT_NOT_OF_VARIANT" });
        next = { ...line, unitId: a.unitId, confirmed: true };
        break;
      }
      case "USE_TOTAL_DIV_QTY": {
        if (result.receiptCurrency === null) throw new RuleError("INVALID_INPUT", { reason: "CURRENCY" });
        const price = priceFromTotal(line, result.receiptCurrency);
        if (price === null) throw new RuleError("INVALID_INPUT", { lineNo: String(line.lineNo) });
        const printed = line.priceFromTotal ? line.printedUnitPrice : line.unitPrice;
        next = { ...line, unitPrice: price, priceFromTotal: true, ...(printed !== undefined ? { printedUnitPrice: printed } : {}) };
        break;
      }
      case "DISCARD":
        next = { ...line, discarded: true };
        break;
    }
    const lines = result.lines.map((l) => (l.lineNo === line.lineNo ? next : l));
    const updated = await reevaluate(tx, { ...result, lines });
    await saveResult(tx, row, updated, state.stockDocumentId === null && row.status === "DRAFTED" ? { status: "READ", stockDocumentId: null } : {});
    return { intakeId: row.id, version: row.version + 1 };
  },
  audit: (input, value) => ({ entity: "RtIntake", entityId: value.intakeId, changes: { lineNo: input.lineNo, action: input.action.kind, version: value.version } }),
});

/** The reviewer's choice of the receipt currency (an enabled one). Prices derived from totals go back to the printed ones. */
export const setIntakeCurrency = defineAction({
  name: "intake.currency",
  permission: "stock.receive",
  input: z.object({ intakeId: id, currency: z.enum(Currency), expectedVersion: version }).strict(),
  writes: true,
  precondition: writePrecondition,
  async run({ actor, tx, input, lockBusiness }): Promise<{ intakeId: string; version: number }> {
    const { row, state } = await openForReview(tx, actor, input.intakeId, input.expectedVersion, lockBusiness);
    assertInReview(state);
    const biz = await businessOf(tx);
    if (!biz.enabledCurrencies.includes(input.currency)) throw new RuleError("STOCK_RULE", { reason: "CURRENCY_NOT_ENABLED" });
    const result = resultOf(row);
    const lines = result.lines.map((l): IntakeLine => {
      if (!l.priceFromTotal) return l;
      const back: IntakeLine = { ...l, unitPrice: l.printedUnitPrice };
      delete back.printedUnitPrice;
      delete back.priceFromTotal;
      if (back.unitPrice === undefined) delete back.unitPrice;
      return back;
    });
    const updated = await reevaluate(tx, { ...result, receiptCurrency: input.currency, lines });
    await saveResult(tx, row, updated, state.stockDocumentId === null && row.status === "DRAFTED" ? { status: "READ", stockDocumentId: null } : {});
    return { intakeId: row.id, version: row.version + 1 };
  },
  audit: (input, value) => ({ entity: "RtIntake", entityId: value.intakeId, changes: { currency: input.currency, version: value.version } }),
});

/** Decimals a new base unit needs for the printed quantity (0..3; more is left to the checks). */
function quantityScaleOf(quantity: string): number {
  const m = /\.(\d+)$/.exec(plainQuantity(quantity));
  return m ? Math.min(3, m[1]!.replace(/0+$/, "").length) : 0;
}

/**
 * Creates a minimal catalog item for each named line (no item yet, not discarded), all in this
 * transaction or none, at most 50, and assigns it (its base unit) to the line. Needs catalog.manage.
 */
export const createIntakeItems = defineAction({
  name: "intake.items.create",
  permission: "stock.receive",
  input: z
    .object({ intakeId: id, lineNos: z.array(z.number().int().min(1).max(1000)).min(1).max(MAX_NEW_ITEMS), expectedVersion: version })
    .strict()
    .refine((v) => new Set(v.lineNos).size === v.lineNos.length),
  writes: true,
  timeoutMs: 30_000,
  precondition: itemsPrecondition,
  async run({ actor, tx, input, lockBusiness }): Promise<{ intakeId: string; version: number; created: number }> {
    const { row, state } = await openForReview(tx, actor, input.intakeId, input.expectedVersion, lockBusiness);
    assertInReview(state);
    const result = resultOf(row);
    const targets = input.lineNos.map((n) => {
      const line = result.lines.find((l) => l.lineNo === n);
      if (!line) throw new NotFoundError();
      if (line.discarded || line.variantId) throw new RuleError("INVALID_INPUT", { lineNo: String(n) });
      return line;
    });
    const assigned = new Map<number, { variantId: string; unitId: string }>();
    for (const line of [...targets].sort((x, y) => x.lineNo - y.lineNo)) {
      const unitText = line.unitText?.trim();
      const created = await createMinimalProductInTx(tx, actor.businessId, {
        nameAr: line.description.trim(),
        baseUnitName: unitText && normalizeSearchText(unitText) !== "" ? unitText : DEFAULT_BASE_UNIT,
        quantityScale: quantityScaleOf(line.quantity),
      });
      assigned.set(line.lineNo, { variantId: created.variantId, unitId: created.baseUnitId });
    }
    const lines = result.lines.map((l): IntakeLine => {
      const a = assigned.get(l.lineNo);
      return a ? { ...l, ...a, source: "REVIEWER", confirmed: true, candidates: undefined, notes: l.notes.filter((n) => BARCODE_NOTES.has(n)) } : l;
    });
    const updated = await reevaluate(tx, { ...result, lines });
    await saveResult(tx, row, updated, state.stockDocumentId === null && row.status === "DRAFTED" ? { status: "READ", stockDocumentId: null } : {});
    return { intakeId: row.id, version: row.version + 1, created: assigned.size };
  },
  audit: (input, value) => ({ entity: "RtIntake", entityId: value.intakeId, changes: { lineNos: input.lineNos, created: value.created, version: value.version } }),
});

function supplierRefOf(r: IntakeResult): string | null {
  const parts = [r.supplier?.trim(), r.receiptNo?.trim() ? `#${r.receiptNo.trim()}` : undefined, r.date?.trim()].filter((p): p is string => !!p);
  return parts.length ? parts.join(" · ").slice(0, MAX_SUPPLIER_REF) : null;
}

/**
 * Makes the RECEIPT draft from a settled intake. INTAKE_UNRESOLVED while a kept line is not
 * MATCHED (re-checked against the catalog now) or the currency is not chosen. A live draft made
 * earlier is returned as is; a deleted one may be made again.
 */
export const createDraftFromIntake = defineAction({
  name: "intake.draft.create",
  permission: "stock.receive",
  input: z.object({ intakeId: id, expectedVersion: version }).strict(),
  writes: true,
  timeoutMs: 20_000,
  precondition: writePrecondition,
  async run({ actor, tx, input, lockBusiness }): Promise<{ documentId: string }> {
    const { row, state } = await openForReview(tx, actor, input.intakeId, input.expectedVersion, lockBusiness);
    if (state.status === "DRAFTED" && state.stockDocumentId) return { documentId: state.stockDocumentId };
    assertInReview(state);
    const result = await reevaluate(tx, resultOf(row));
    if (result.receiptCurrency === null) throw new RuleError("INTAKE_UNRESOLVED", { reason: "CURRENCY" });
    const open = result.lines.find((l) => !l.discarded && !l.resolved);
    if (open) throw new RuleError("INTAKE_UNRESOLVED", { lineNo: String(open.lineNo) });
    const kept = result.lines.filter((l) => !l.discarded);
    if (kept.length === 0) throw new RuleError("INVALID_INPUT", { reason: "EMPTY" });
    const currency = result.receiptCurrency;
    const lines: DraftLineInput[] = kept.map((l) => ({
      variantId: l.variantId!,
      unitId: l.unitId!,
      quantity: plainQuantity(l.quantity),
      ...(l.unitPrice !== undefined ? { cost: { amount: plainMoney(l.unitPrice), currency } } : {}),
    }));
    const draft = await createReceiptDraftInTx(tx, actor, { supplierRef: supplierRefOf(result), note: null, lines });
    await updateVersioned(tx.rtIntake, { id: row.id }, row.version, { status: "DRAFTED", stockDocumentId: draft.documentId, result: asJson(result) });
    return { documentId: draft.documentId };
  },
  audit: (input, value) => ({ entity: "RtIntake", entityId: input.intakeId, changes: { documentId: value.documentId } }),
});
