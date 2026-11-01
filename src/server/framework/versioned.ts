import { VersionConflictError } from "./errors";

type UpdateManyDelegate = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- accepts any Prisma model delegate
  updateMany(args: any): Promise<{ count: number }>;
};

/**
 * Optimistic-version update: changes the row only if its version is still `expectedVersion`, and
 * increments the version. Throws VersionConflictError when no row matched (stale version, or the
 * row is missing / outside the actor's scope; defineAction maps it to VERSION_CONFLICT).
 * Run it inside an action so the failure rolls the whole transaction back.
 */
export async function updateVersioned(
  delegate: UpdateManyDelegate,
  where: Record<string, unknown>,
  expectedVersion: number,
  data: Record<string, unknown>,
): Promise<void> {
  if ("version" in data) throw new Error("updateVersioned: data must not set version");
  const { count } = await delegate.updateMany({
    where: { AND: [where, { version: expectedVersion }] },
    data: { ...data, version: { increment: 1 } },
  });
  if (count === 0) throw new VersionConflictError();
}
