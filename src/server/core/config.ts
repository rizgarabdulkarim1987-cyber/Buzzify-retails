/*
 * Settings for the Retails <-> Studio (core) link. Environment is read lazily, on each access, so
 * tests can set it and a missing value fails at the point of use. Errors name the variable only,
 * never a value.
 */

export class CoreConfigError extends Error {
  readonly variable: string;
  constructor(variable: string) {
    super(`Missing or invalid (too short) environment variable ${variable}`);
    this.name = "CoreConfigError";
    this.variable = variable;
  }
}

const MIN_SECRET_LENGTH = 16;

/** A trimmed, non-empty value; secrets (everything but the URL) must also be >= 16 chars. */
function read(name: string, secret: boolean): string | undefined {
  const v = process.env[name]?.trim();
  if (!v) return undefined;
  if (secret && v.length < MIN_SECRET_LENGTH) throw new CoreConfigError(name);
  return v;
}

function required(name: string, secret = true): string {
  const v = read(name, secret);
  if (!v) throw new CoreConfigError(name);
  return v;
}

/** The current secret, then the previous one when set (rotation window). */
function withPrevious(name: string): string[] {
  const list = [required(name)];
  const prev = read(`${name}_PREVIOUS`, true);
  if (prev) list.push(prev);
  return list;
}

export function coreConfig() {
  return {
    /** Studio (core) base URL, no trailing slash. */
    get baseUrl(): string {
      const url = required("CORE_BASE_URL", false).replace(/\/+$/, "");
      // The signed requests carry the Anthropic key back: never over plain http in production.
      if (process.env.NODE_ENV === "production" && !url.toLowerCase().startsWith("https://")) throw new CoreConfigError("CORE_BASE_URL");
      return url;
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
