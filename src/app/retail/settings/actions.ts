"use server";

import { revokeAiConsent } from "@/server/intake/consent";
import { call } from "../catalog/_lib/call";
import type { UiResult } from "../catalog/_lib/types";

/*
 * The AI settings page's door (granting consent reuses grantAiConsentAction of the receipt-photo
 * screens). The session and business come from the server; the action checks everything.
 */

/** The owner withdraws the consent to send images (allowed with the AI switch off and while read-only). */
export async function revokeAiConsentAction(key: unknown): Promise<UiResult<{ revoked: true }>> {
  return call(key, (m) => revokeAiConsent({}, m), () => ({ revoked: true as const }));
}
