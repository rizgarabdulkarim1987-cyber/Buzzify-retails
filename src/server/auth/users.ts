import { db } from "@/server/db";

/*
 * Lookups in the Better Auth User table, which tenant code cannot reach through scopedDb. Used by
 * the setup wizard to add an existing account as staff, and to show staff names. Emails compare
 * case-insensitively (Better Auth may keep the case the user typed).
 */

/** Lowercased email -> user id, for the emails that have an account. At most 100 emails per call. */
export async function findUserIdsByEmail(emails: readonly string[]): Promise<Map<string, string>> {
  const wanted = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter((e) => e !== ""))].slice(0, 100);
  if (wanted.length === 0) return new Map();
  const rows = await db.user.findMany({
    where: { OR: wanted.map((email) => ({ email: { equals: email, mode: "insensitive" as const } })) },
    select: { id: true, email: true },
  });
  return new Map(rows.map((r) => [r.email.trim().toLowerCase(), r.id]));
}

/**
 * Display name and email of the given users. The caller passes only ids it already read through
 * its scoped client (its own business's staff), so this reveals nothing about other businesses.
 */
export async function userLabels(ids: readonly string[]): Promise<Map<string, { name: string; email: string }>> {
  const unique = [...new Set(ids)].slice(0, 500);
  if (unique.length === 0) return new Map();
  const rows = await db.user.findMany({ where: { id: { in: unique } }, select: { id: true, name: true, email: true } });
  return new Map(rows.map((r) => [r.id, { name: r.name, email: r.email }]));
}
