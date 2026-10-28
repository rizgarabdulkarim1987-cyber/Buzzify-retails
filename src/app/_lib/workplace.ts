/*
 * The chosen workplace (business, branch, optional terminal) lives in a cookie. The cookie is only
 * a preference: every request re-checks it against the actor's scoped options, so an edited or
 * stale cookie selects nothing the user is not allowed to use.
 */

export const WORKPLACE_COOKIE = "rt_workplace";

export type Workplace = { businessId: string; branchId: string; terminalId: string | null };

const ID = /^[A-Za-z0-9_-]{1,64}$/;

export function isId(value: unknown): value is string {
  return typeof value === "string" && ID.test(value);
}

export function encodeWorkplace(w: Workplace): string {
  return [w.businessId, w.branchId, w.terminalId ?? ""].join(".");
}

export function decodeWorkplace(raw: string | undefined): Workplace | null {
  if (!raw) return null;
  const parts = raw.split(".");
  if (parts.length !== 3) return null;
  const [businessId, branchId, terminalId] = parts as [string, string, string];
  if (!isId(businessId) || !isId(branchId) || (terminalId !== "" && !isId(terminalId))) return null;
  return { businessId, branchId, terminalId: terminalId === "" ? null : terminalId };
}

export const WORKPLACE_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: "lax",
  path: "/",
  secure: process.env.NODE_ENV === "production",
  maxAge: 60 * 60 * 24 * 30,
} as const;
