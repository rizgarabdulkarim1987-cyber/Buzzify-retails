"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { overrideFeature } from "@/server/admin/lifecycle";
import { provisionBusiness } from "@/server/admin/provision";
import { getSessionUserId } from "@/server/auth/auth";
import { IdempotencyMismatchError, InternalActionError, type ErrorCode } from "@/server/framework/errors";
import { AI_INTAKE_FEATURE } from "@/server/framework/features";
import type { AiSwitchResult } from "./ai-switch-rules";

export type CreateBusinessState =
  | { status: "idle" }
  | { status: "created"; name: string; email: string }
  | { status: "failed"; code: ErrorCode | "INTERNAL" };

const lines = (value: FormDataEntryValue | null) =>
  String(value ?? "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s !== "");

/**
 * The create-business form, wired to the existing provisioning action. The idempotency key comes
 * from the rendered form, so a double submit of one form creates exactly one business.
 */
export async function createBusiness(_prev: CreateBusinessState, formData: FormData): Promise<CreateBusinessState> {
  const userId = await getSessionUserId(await headers());
  if (!userId) return { status: "failed", code: "FORBIDDEN" };

  const defaultCurrency = String(formData.get("defaultCurrency") ?? "");
  const other = defaultCurrency === "USD" ? "IQD" : "USD";
  const input = {
    name: String(formData.get("name") ?? ""),
    activityType: String(formData.get("activityType") ?? ""),
    capabilities: formData.getAll("capabilities").map(String),
    branches: lines(formData.get("branches")).map((name) => ({ name })),
    ownerEmail: String(formData.get("ownerEmail") ?? ""),
    currencies: formData.get("secondCurrency") === "on" ? [defaultCurrency, other] : [defaultCurrency],
    planCode: String(formData.get("planCode") ?? ""),
    trialDays: Number(formData.get("trialDays")),
  };

  try {
    const result = await provisionBusiness(input, { userId, idempotencyKey: String(formData.get("idempotencyKey") ?? "") });
    if (!result.ok) return { status: "failed", code: result.code };
  } catch (err) {
    // The framework already turns a reused key into IDEMPOTENCY_MISMATCH; kept here so a change there never crashes the form.
    if (err instanceof IdempotencyMismatchError) return { status: "failed", code: "IDEMPOTENCY_MISMATCH" };
    if (err instanceof InternalActionError) return { status: "failed", code: "INTERNAL" };
    throw err;
  }
  revalidatePath("/admin");
  return { status: "created", name: input.name.trim(), email: input.ownerEmail.trim().toLowerCase() };
}

/**
 * The ai.intake master switch of one business (platform admin only; overrideFeature checks that,
 * the reason and the business). The key comes from the browser and is kept while the same change
 * is retried, so a retry after a lost answer records one change.
 */
export async function setAiIntake(input: { businessId: unknown; enabled: unknown; reason: unknown; key: unknown }): Promise<AiSwitchResult> {
  const userId = await getSessionUserId(await headers());
  if (!userId) return { ok: false, code: "FORBIDDEN" };
  if (typeof input?.enabled !== "boolean") return { ok: false, code: "INVALID_INPUT" };
  const enabled = input.enabled;
  try {
    const result = await overrideFeature(
      { businessId: input.businessId, feature: AI_INTAKE_FEATURE, enabled, reason: input.reason },
      { userId, idempotencyKey: typeof input.key === "string" ? input.key : "" },
    );
    if (!result.ok) return { ok: false, code: result.code };
  } catch (err) {
    if (err instanceof IdempotencyMismatchError) return { ok: false, code: "IDEMPOTENCY_MISMATCH" };
    if (err instanceof InternalActionError) return { ok: false, code: "INTERNAL" };
    throw err;
  }
  revalidatePath("/admin");
  return { ok: true, enabled };
}
