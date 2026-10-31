import type { CoreClient } from "./client";

/*
 * Test double for the Studio client. getCoreClient() returns whatever setCoreClientFake installed,
 * outside production only (production ignores it, as it ignores the intake fake provider).
 */

/** Deterministic: a fixed key, and a stable identity id derived from the email. */
export function createFakeCoreClient(): CoreClient {
  return {
    async getAiConfig() {
      return { apiKey: "fake-studio-key-0000", model: null };
    },
    async ensureIdentity(email) {
      return { coreUserId: `fake_${email.trim().toLowerCase()}`, created: false };
    },
  };
}

/** Installs (or, with undefined, removes) the fake for this process. */
export function setCoreClientFake(client: CoreClient | undefined): void {
  globalThis.__coreClientFake = client;
}
