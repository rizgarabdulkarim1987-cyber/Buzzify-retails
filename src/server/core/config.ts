/*
 * Settings for the Retails <-> Studio (core) link. Environment is read lazily, on each access, so
 * tests can set it and a missing value fails at the point of use. Errors name the variable only,
 * never a value.
 */

export class CoreConfigError extends Error {
  readonly variable: string;
  constructor(variable: string) {
    super(`Missing required environment variable ${variable}`);
    this.name = "CoreConfigError";
    this.variable = variable;
  }
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new CoreConfigError(name);
  return v;
}

/** The current secret, then the previous one when set (rotation window). */
function withPrevious(name: string): string[] {
  const list = [required(name)];
  const prev = process.env[`${name}_PREVIOUS`];
  if (prev) list.push(prev);
  return list;
}

export function coreConfig() {
  return {
    /** Studio (core) base URL, no trailing slash. */
    get baseUrl(): string {
      return required("CORE_BASE_URL").replace(/\/+$/, "");
    },
    /** Secrets accepted on inbound signed requests (Studio -> Retails). */
    get syncSecrets(): string[] {
      return withPrevious("CORE_SYNC_SECRET");
    },
    /** Secret that signs outbound requests (Retails -> Studio). */
    get outSecret(): string {
      return required("CORE_OUT_SECRET");
    },
    /** Secrets accepted on handoff tokens. */
    get handoffSecrets(): string[] {
      return withPrevious("CORE_HANDOFF_SECRET");
    },
  };
}
