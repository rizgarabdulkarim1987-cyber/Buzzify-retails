import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { defineAction } from "@/server/framework/action";
import { RuleError } from "@/server/framework/errors";
import { aiEnabledPrecondition } from "@/server/framework/features";

type Tx = Prisma.TransactionClient;

/*
 * The owner's consent to send the business's images to the AI provider (spec 3.11, 3ب.5).
 * Stored on RtBusiness as aiConsentAt + aiConsentVersion. A consent counts only for the current
 * consent text: raising CONSENT_VERSION voids every earlier consent until the owner grants again.
 * Only the OWNER holds `ai.consent`. Granting sits behind the ai.intake master switch (spec 9) and
 * needs a FULL gate. Revoking reduces exposure, so it is allowed with the switch off and while the
 * business is READ_ONLY (never when CLOSED). Revoking stops new reads only: it deletes nothing (images go by the retention policy, quota
 * rows stay) and does not stop a read already under way.
 */

/** Version of the consent text the owner agrees to. Raise it when the text changes. */
export const CONSENT_VERSION = 1;

/** Refuses with AI_CONSENT_REQUIRED unless the business consented to the current text. `tx` may be scoped. */
export async function assertConsent(tx: Tx, businessId: string): Promise<void> {
  const b = await tx.rtBusiness.findFirst({ where: { id: businessId }, select: { aiConsentAt: true, aiConsentVersion: true } });
  if (!b || b.aiConsentAt === null || b.aiConsentVersion !== CONSENT_VERSION) throw new RuleError("AI_CONSENT_REQUIRED");
}

export type ConsentState = { businessId: string; consentAt: string | null; consentVersion: number | null };

/**
 * Sets the consent columns and bumps the business version (no expectedVersion: consenting is not an
 * edit of the business form, but other version-checked edits must see that the row changed).
 */
async function setConsent(tx: Tx, businessId: string, at: Date | null): Promise<ConsentState> {
  const version = at === null ? null : CONSENT_VERSION;
  const { count } = await tx.rtBusiness.updateMany({
    where: { id: businessId },
    data: { aiConsentAt: at, aiConsentVersion: version, version: { increment: 1 } },
  });
  if (count !== 1) throw new Error("setConsent: business not found in scope");
  return { businessId, consentAt: at?.toISOString() ?? null, consentVersion: version };
}

export const grantAiConsent = defineAction({
  name: "ai.consent.grant",
  permission: "ai.consent",
  input: z.object({}).strict(),
  writes: true,
  precondition: aiEnabledPrecondition,
  run: ({ actor, tx }) => setConsent(tx, actor.businessId, new Date()),
  audit: (_input, value) => ({
    entity: "RtBusiness",
    entityId: value.businessId,
    changes: { aiConsentAt: value.consentAt, aiConsentVersion: value.consentVersion },
  }),
});

export const revokeAiConsent = defineAction({
  name: "ai.consent.revoke",
  permission: "ai.consent",
  input: z.object({}).strict(),
  writes: true,
  // No master-switch precondition: an owner can always withdraw consent.
  allowWhenReadOnly: true,
  run: ({ actor, tx }) => setConsent(tx, actor.businessId, null),
  audit: (_input, value) => ({ entity: "RtBusiness", entityId: value.businessId, changes: { aiConsentAt: null, aiConsentVersion: null } }),
});
