import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { normalizeBarcode } from "@/server/domain/catalog";
import { INTAKE_MAX_BYTES, barcodeCheck, normalizeDigits } from "@/server/domain/intake";
import { can } from "@/server/domain/permissions";
import type { Actor } from "@/server/framework/actor";
import { defineAction, validKey, type ActionMeta } from "@/server/framework/action";
import { ForbiddenError, RuleError, failure, type Result } from "@/server/framework/errors";
import { aiEnabledPrecondition } from "@/server/framework/features";
import { assertConsent } from "./consent";
import { AiBadOutputError, AiUnavailableError, getIntakeProvider } from "./provider";
import { refundUnits, reserveUnits } from "./quota";
import { sniffPageType } from "./receipts";

type Tx = Prisma.TransactionClient;

/*
 * Barcodes (spec 3.7-3.9, 3.14, 3ب.4, 9).
 *
 * lookupBarcode: what a code belongs to in this business. The camera decodes in the browser (no
 * AI), so this is NOT behind the ai.intake switch and needs no consent; any member holding
 * stock.view or catalog.manage may call it (every role holds stock.view today). The code goes
 * through R1's normalisation (Arabic-Indic / Persian digits to ASCII, trimmed, leading zeros kept;
 * empty, > 64 characters or other characters: INVALID_INPUT). An exact hit (archived codes, archived
 * or trial items included, flagged as such) is KNOWN, so the owner is always shown, even for a code
 * the shop stored earlier that fails the retail checksum. Otherwise a digit-only code of retail
 * length (8, 12, 13) with a wrong check digit is INVALID_CHECKSUM, anything else UNKNOWN (checked
 * says whether the retail checksum was verified). Answers carry names, ids, SKU and flags only:
 * never prices or costs. Linking a code uses addBarcode as it is (catalog.manage; a code owned by
 * another unit is R1's BARCODE_TAKEN naming the owner), a new item R1's quick create.
 *
 * readBarcodeFromImage: the AI fallback when the browser cannot decode. ai.use + catalog.manage, the
 * master switch (re-checked on every call, replays included), a FULL gate, the owner's consent, one
 * half unit of quota. One JPEG/PNG/WebP image <= INTAKE_MAX_BYTES, type sniffed from the bytes and
 * equal to the declared one, checked before anything else (INVALID_INPUT). The bytes are never
 * stored: the idempotency payload is their sha256. The model's digits are data: they pass the digit
 * gate and normalisation on the server, a retail-length code with a wrong check digit is
 * INVALID_CHECKSUM and its digits are never returned or kept; no digits is NOT_READABLE. Both are
 * charged (the provider worked). A valid code answers what lookupBarcode answers for it.
 *
 * Steps (no table of its own; durable state is two idempotency rows, keys derived from the caller's
 * key, so a replay or a parallel call with the same key finds them):
 * 1. start (key <k>:start, payload the image hash): switch, permissions, gate, consent, then
 *    reserveUnits(1) in a short transaction. Its value is a claim {claimId, month, startedAt}; the
 *    claimId is made inside run, so only the caller whose run committed sees its own id back: that
 *    caller is the claimer and the only one to call the provider. A same-key call gets the stored
 *    claim (a replay: nothing reserved again) and does not call the provider.
 * 2. the claimer calls the provider OUTSIDE any transaction, with a timeout, right after step 1
 *    committed (step 1 is the pre-call check of switch and consent: nothing runs in between).
 * 3. finish (key <k>:finish, payload {claimId, month}): records the outcome as its stored value and,
 *    for AI_UNAVAILABLE / AI_BAD_OUTPUT, refunds the half unit in the same transaction. The
 *    idempotency row makes it run once per claim: the refund happens at most once. Like Task 5's
 *    closing steps it needs neither the switch nor ai.use / catalog.manage nor a FULL gate (allowed
 *    while READ_ONLY, never CLOSED): it only records what already happened.
 * A non-claimer polls finish with no outcome of its own (that run refuses, the transaction rolls
 * back, nothing is consumed) until the claimer's outcome is stored, then answers the same. If the
 * claim's lease (provider timeout + margin) has run out, it finishes the claim itself as
 * AI_UNAVAILABLE with the refund; a late claimer then gets that stored outcome.
 */

export const BARCODE_READ_TIMEOUT_MS = 30_000;
/** A claim's lease: provider timeout plus a margin; past it a waiting same-key call fails the claim with its refund. */
export const BARCODE_LEASE_MS = BARCODE_READ_TIMEOUT_MS + 30_000;
const POLL_MAX_MS = 2_000;
const MAX_INPUT_CODE = 100;
/** The digits a model may answer with (ASCII, Arabic-Indic, Persian); anything else is not a barcode. */
const DIGIT_GATE = /^[0-9٠-٩۰-۹]{1,32}$/;

// ---------------------------------------------------------------------------------------------
// lookupBarcode

export type BarcodeLookup =
  | {
      status: "KNOWN";
      code: string;
      productId: string;
      variantId: string;
      unitId: string;
      unitName: string;
      nameAr: string;
      nameCkb?: string;
      nameEn?: string;
      sku: string;
      /** The code, its unit, variant or product is archived. */
      archived: boolean;
      /** A trial item entered during setup. */
      isTestData: boolean;
    }
  | { status: "UNKNOWN"; code: string; checked: boolean }
  | { status: "INVALID_CHECKSUM" };

const codeInput = z
  .object({
    code: z
      .string()
      .max(MAX_INPUT_CODE)
      .transform((v, ctx) => {
        try {
          return normalizeBarcode(v);
        } catch {
          ctx.addIssue({ code: "custom", message: "invalid barcode" });
          return z.NEVER;
        }
      }),
  })
  .strict();

async function lookupInTx(tx: Tx, code: string): Promise<BarcodeLookup> {
  const hit = await tx.rtBarcode.findFirst({
    where: { code },
    select: {
      archivedAt: true,
      unit: {
        select: {
          id: true,
          name: true,
          archivedAt: true,
          variant: {
            select: {
              id: true,
              sku: true,
              archivedAt: true,
              product: { select: { id: true, nameAr: true, nameCkb: true, nameEn: true, isTestData: true, archivedAt: true } },
            },
          },
        },
      },
    },
  });
  if (hit) {
    const { unit } = hit;
    const { variant } = unit;
    const { product } = variant;
    return {
      status: "KNOWN",
      code,
      productId: product.id,
      variantId: variant.id,
      unitId: unit.id,
      unitName: unit.name,
      nameAr: product.nameAr,
      ...(product.nameCkb ? { nameCkb: product.nameCkb } : {}),
      ...(product.nameEn ? { nameEn: product.nameEn } : {}),
      sku: variant.sku,
      archived: hit.archivedAt !== null || unit.archivedAt !== null || variant.archivedAt !== null || product.archivedAt !== null,
      isTestData: product.isTestData,
    };
  }
  const check = barcodeCheck(code);
  if (check.checked && !check.ok) return { status: "INVALID_CHECKSUM" };
  return { status: "UNKNOWN", code, checked: check.checked };
}

/** What a scanned or typed code belongs to in this business (see the file comment). Not behind the AI switch. */
export const lookupBarcode = defineAction({
  name: "barcode.lookup",
  // stock.view OR catalog.manage: defineAction takes one permission, so both are checked in run.
  permission: null,
  input: codeInput,
  writes: false,
  async run({ actor, tx, input }): Promise<BarcodeLookup> {
    if (!can(actor.role, "stock.view") && !can(actor.role, "catalog.manage")) throw new ForbiddenError("stock.view");
    return lookupInTx(tx, input.code);
  },
});

// ---------------------------------------------------------------------------------------------
// readBarcodeFromImage: upload validation

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
type ImageType = (typeof IMAGE_TYPES)[number];
const DECLARED_ALIASES: Record<string, ImageType> = { "image/jpg": "image/jpeg", "image/pjpeg": "image/jpeg" };

const imageInput = z.object({ image: z.object({ contentType: z.string().max(100), bytes: z.instanceof(Uint8Array) }).strict() }).strict();

type Image = { contentType: ImageType; bytes: Uint8Array; sha256: string };

/** One JPEG/PNG/WebP image, 1 byte..INTAKE_MAX_BYTES, its sniffed type equal to the declared one; else null. */
function validateImage(raw: unknown): Image | null {
  const parsed = imageInput.safeParse(raw);
  if (!parsed.success) return null;
  const { contentType, bytes } = parsed.data.image;
  if (bytes.byteLength === 0 || bytes.byteLength > INTAKE_MAX_BYTES) return null;
  const sniffed = sniffPageType(bytes);
  if (sniffed === null || !(IMAGE_TYPES as readonly string[]).includes(sniffed)) return null;
  const declared = contentType.trim().toLowerCase();
  if ((DECLARED_ALIASES[declared] ?? declared) !== sniffed) return null;
  return { contentType: sniffed as ImageType, bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}

// ---------------------------------------------------------------------------------------------
// readBarcodeFromImage: steps

async function readPrecondition(ctx: { actor: Actor }): Promise<void> {
  if (!can(ctx.actor.role, "ai.use")) throw new ForbiddenError("ai.use");
  await aiEnabledPrecondition(ctx);
}

type Claim = { claimId: string; month: string; startedAt: number };

/** Step 1: consent and the half unit; the claim id is made here (see the file comment). */
function startAction(claimId: string) {
  return defineAction({
    name: "barcode.read.start",
    permission: "catalog.manage",
    input: z.object({ imageHash: z.string().regex(/^[0-9a-f]{64}$/) }).strict(),
    writes: true,
    precondition: readPrecondition,
    async run({ actor, tx }): Promise<Claim> {
      await assertConsent(tx, actor.businessId);
      const now = new Date();
      const { month } = await reserveUnits(tx, { businessId: actor.businessId, halfUnits: 1, now });
      return { claimId, month, startedAt: now.getTime() };
    },
    audit: (_input, value) => ({ entity: "RtAiUsage", entityId: value.month, changes: { reservedHalfUnits: 1, claimId: value.claimId } }),
  });
}

type FailCode = "AI_UNAVAILABLE" | "AI_BAD_OUTPUT";

/** What one AI read came to. CODE carries only a code that passed the gate and the checksum. */
type Outcome = { kind: "CODE"; code: string } | { kind: "NOT_READABLE" } | { kind: "INVALID_CHECKSUM" } | { kind: "FAILED"; code: FailCode };

/** Refusal of a finish call that has no outcome to record (the claimer has not finished yet). */
const PENDING = { reason: "PENDING" } as const;

/**
 * Step 3: records `outcome` once per claim (its idempotency row) and refunds a failed read in the
 * same transaction. Without an outcome it refuses NOT_FOUND {reason: PENDING} and consumes nothing.
 */
function finishAction(outcome: Outcome | null) {
  return defineAction({
    name: "barcode.read.finish",
    permission: null,
    writes: true,
    allowWhenReadOnly: true,
    input: z.object({ claimId: z.string().uuid(), month: z.string().regex(/^\d{4}-\d{2}$/) }).strict(),
    async run({ actor, tx, input }): Promise<Outcome & { refunded: boolean }> {
      if (outcome === null) throw new RuleError("NOT_FOUND", PENDING);
      const refunded = outcome.kind === "FAILED";
      if (refunded) await refundUnits(tx, { businessId: actor.businessId, month: input.month, halfUnits: 1 });
      return { ...outcome, refunded };
    },
    audit: (input, value) => ({
      entity: "RtAiUsage",
      entityId: input.month,
      changes: { claimId: input.claimId, outcome: value.kind, ...(value.kind === "FAILED" ? { code: value.code } : {}), refundedHalfUnits: value.refunded ? 1 : 0 },
    }),
  });
}

/** The model's answer through the digit gate, normalisation and the retail checksum. */
function outcomeOfDigits(digits: string | null): Outcome {
  if (digits === null) return { kind: "NOT_READABLE" };
  const raw = digits.trim();
  if (!DIGIT_GATE.test(raw)) return { kind: "FAILED", code: "AI_BAD_OUTPUT" };
  const code = normalizeDigits(raw);
  const check = barcodeCheck(code);
  if (check.checked && !check.ok) return { kind: "INVALID_CHECKSUM" };
  return { kind: "CODE", code: normalizeBarcode(code) };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const stepKey = (key: string, step: "start" | "finish") => `barcode-read:${createHash("sha256").update(key).digest("hex")}:${step}`;

/** Logs an unexpected error by its class only (never its message: it could carry provider output). */
const logUnexpected = (where: string, err: unknown) => console.error(`[${where}] unexpected failure: ${err instanceof Error ? err.name : typeof err}`);

export type BarcodeRead = BarcodeLookup | { status: "NOT_READABLE" };

/**
 * Reads a barcode's digits from one photo with the AI provider when the browser could not decode it
 * (see the file comment). `meta.idempotencyKey` is per attempt: a retry with the same key and image
 * answers the same without a second reservation or provider call.
 */
export async function readBarcodeFromImage(raw: unknown, meta: ActionMeta): Promise<Result<BarcodeRead>> {
  const img = validateImage(raw);
  if (!img || !validKey(meta.idempotencyKey)) return failure("INVALID_INPUT");
  const startMeta = { ...meta, idempotencyKey: stepKey(meta.idempotencyKey, "start") };
  const finishMeta = { ...meta, idempotencyKey: stepKey(meta.idempotencyKey, "finish") };

  const myClaim = randomUUID();
  const started = await startAction(myClaim)({ imageHash: img.sha256 }, startMeta);
  if (!started.ok) return started;
  const claim = started.value;
  const finishInput = { claimId: claim.claimId, month: claim.month };

  let finished: Result<Outcome & { refunded: boolean }>;
  if (claim.claimId === myClaim) {
    let outcome: Outcome;
    try {
      const answer = await getIntakeProvider().readBarcode(
        { contentType: img.contentType, bytes: img.bytes },
        { signal: AbortSignal.timeout(BARCODE_READ_TIMEOUT_MS) },
      );
      outcome = outcomeOfDigits(answer.digits);
    } catch (err) {
      if (!(err instanceof AiUnavailableError) && !(err instanceof AiBadOutputError)) logUnexpected("barcode.read.provider", err);
      outcome = { kind: "FAILED", code: err instanceof AiBadOutputError ? "AI_BAD_OUTPUT" : "AI_UNAVAILABLE" };
    }
    finished = await finishAction(outcome)(finishInput, finishMeta);
  } else {
    finished = await awaitOutcome(claim, finishInput, finishMeta);
  }
  if (!finished.ok) return finished;

  const o = finished.value;
  switch (o.kind) {
    case "FAILED":
      return failure(o.code);
    case "NOT_READABLE":
      return { ok: true, value: { status: "NOT_READABLE" } };
    case "INVALID_CHECKSUM":
      return { ok: true, value: { status: "INVALID_CHECKSUM" } };
    case "CODE":
      return lookupBarcode({ code: o.code }, meta);
  }
}

/** A same-key call: waits for the claimer's stored outcome; past the claim's lease, fails it with the refund. */
async function awaitOutcome(claim: Claim, input: { claimId: string; month: string }, meta: ActionMeta): Promise<Result<Outcome & { refunded: boolean }>> {
  let delay = 100;
  for (;;) {
    const expired = Date.now() > claim.startedAt + BARCODE_LEASE_MS;
    const r = await finishAction(expired ? { kind: "FAILED", code: "AI_UNAVAILABLE" } : null)(input, meta);
    if (r.ok || r.code !== "NOT_FOUND" || r.details?.reason !== PENDING.reason) return r;
    await sleep(delay);
    delay = Math.min(delay * 2, POLL_MAX_MS);
  }
}
