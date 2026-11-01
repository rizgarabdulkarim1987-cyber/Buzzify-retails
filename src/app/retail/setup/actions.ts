"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { getSessionUserId } from "@/server/auth/auth";
import { IdempotencyMismatchError, InternalActionError, type ErrorCode } from "@/server/framework/errors";
import { removeTestProducts } from "@/server/catalog/products";
import { completeSetupStep } from "@/server/setup/progress";
import { isId } from "../../_lib/workplace";

export type SetupStepState =
  | { status: "idle" }
  | { status: "saved" }
  | { status: "failed"; code: ErrorCode | "INTERNAL" };

const text = (v: FormDataEntryValue | null) => (typeof v === "string" ? v : "");
const lines = (v: FormDataEntryValue | null) =>
  text(v)
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s !== "");

/** Builds the step's `data` from the form. Validation is the action's job; this only reshapes. */
function stepData(step: number, f: FormData): unknown {
  switch (step) {
    case 1: {
      const defaultCurrency = text(f.get("defaultCurrency"));
      const enabled = f.getAll("enabledCurrencies").map(String);
      return {
        name: text(f.get("name")),
        defaultCurrency,
        // The default currency is always accepted, ticked or not.
        enabledCurrencies: [...new Set([defaultCurrency, ...enabled])],
        timezone: text(f.get("timezone")) || undefined,
        expectedVersion: Number(f.get("expectedVersion")),
      };
    }
    case 2: {
      const renamed = f
        .getAll("branchId")
        .map(String)
        .filter((id) => text(f.get(`name:${id}`)).trim() !== text(f.get(`orig:${id}`)))
        .map((id) => ({ id, name: text(f.get(`name:${id}`)), expectedVersion: Number(f.get(`version:${id}`)) }));
      const added = lines(f.get("newBranches")).map((name) => ({ name }));
      return { branches: [...renamed, ...added] };
    }
    case 3:
      return {
        activityType: text(f.get("activityType")),
        capabilities: f.getAll("capabilities").map(String),
        expectedVersion: Number(f.get("expectedVersion")),
      };
    case 5: {
      const email = text(f.get("email")).trim();
      if (email === "") return { staff: [] };
      return { staff: [{ email, role: text(f.get("role")), branchIds: f.getAll("branchIds").map(String) }] };
    }
    default:
      return {};
  }
}

/** One wizard form. The idempotency key comes from the rendered form, so a double submit saves once. */
export async function submitSetupStep(_prev: SetupStepState, formData: FormData): Promise<SetupStepState> {
  const userId = await getSessionUserId(await headers());
  if (!userId) return { status: "failed", code: "FORBIDDEN" };
  const businessId = formData.get("business");
  if (!isId(businessId)) return { status: "failed", code: "INVALID_INPUT" };
  const step = Number(formData.get("step"));

  try {
    const result = await completeSetupStep(
      { step, data: stepData(step, formData) },
      { userId, businessId, idempotencyKey: text(formData.get("idempotencyKey")) },
    );
    if (!result.ok) return { status: "failed", code: result.code };
  } catch (err) {
    if (err instanceof IdempotencyMismatchError) return { status: "failed", code: "IDEMPOTENCY_MISMATCH" };
    if (err instanceof InternalActionError) return { status: "failed", code: "INTERNAL" };
    throw err;
  }
  revalidatePath("/retail/setup");
  return { status: "saved" };
}

export type TrialRemoveState = { status: "removed"; count: number } | { status: "failed"; code: ErrorCode | "INTERNAL" };

/** Setup step 4: deletes every trial item (isTestData) of the business before launch, freeing its barcodes and SKUs. */
export async function removeTrialItems(key: string, business: string): Promise<TrialRemoveState> {
  const userId = await getSessionUserId(await headers());
  if (!userId) return { status: "failed", code: "FORBIDDEN" };
  if (!isId(business)) return { status: "failed", code: "INVALID_INPUT" };
  try {
    const result = await removeTestProducts({}, { userId, businessId: business, idempotencyKey: key });
    if (!result.ok) return { status: "failed", code: result.code };
    revalidatePath("/retail/setup");
    return { status: "removed", count: result.value.removed };
  } catch (err) {
    if (err instanceof IdempotencyMismatchError) return { status: "failed", code: "IDEMPOTENCY_MISMATCH" };
    if (err instanceof InternalActionError) return { status: "failed", code: "INTERNAL" };
    throw err;
  }
}

export type SkipState = { status: "skipped" } | { status: "failed"; code: ErrorCode | "INTERNAL" };

/** Setup step 6 (opening stock) is optional: marks it skipped. It still completes once opening stock is posted. */
export async function skipSetupStep(key: string, business: string, step: number): Promise<SkipState> {
  const userId = await getSessionUserId(await headers());
  if (!userId) return { status: "failed", code: "FORBIDDEN" };
  if (!isId(business) || step !== 6) return { status: "failed", code: "INVALID_INPUT" };
  try {
    const result = await completeSetupStep({ step, data: { skip: true } }, { userId, businessId: business, idempotencyKey: key });
    if (!result.ok) return { status: "failed", code: result.code };
    revalidatePath("/retail/setup");
    return { status: "skipped" };
  } catch (err) {
    if (err instanceof IdempotencyMismatchError) return { status: "failed", code: "IDEMPOTENCY_MISMATCH" };
    if (err instanceof InternalActionError) return { status: "failed", code: "INTERNAL" };
    throw err;
  }
}
