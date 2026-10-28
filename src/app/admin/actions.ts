"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { provisionBusiness } from "@/server/admin/provision";
import { getSessionUserId } from "@/server/auth/auth";
import { InternalActionError, type ErrorCode } from "@/server/framework/errors";

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
    if (err instanceof InternalActionError) return { status: "failed", code: "INTERNAL" };
    throw err;
  }
  revalidatePath("/admin");
  return { status: "created", name: input.name.trim(), email: input.ownerEmail.trim().toLowerCase() };
}
