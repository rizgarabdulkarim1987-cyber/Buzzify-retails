import { z } from "zod";
import { coreConfig } from "./config";
import { signRequest } from "./signing";

/*
 * Retails -> Studio client: pulls the Anthropic key and makes sure a Studio identity exists for a
 * staff email. Requests are signed with CORE_OUT_SECRET (signing.ts). Errors carry a class and the
 * HTTP status only: never a body, a key, or the URL. Nothing here logs.
 */

export interface CoreClient {
  /** apiKey null = Studio definitively has no key for Retails (HTTP 404 or {apiKey: null}). */
  getAiConfig(): Promise<{ apiKey: string | null; model: string | null }>;
  /** emailVerified: Studio has verified ownership of this email; Retails links accounts only when true. */
  ensureIdentity(email: string, name?: string): Promise<{ coreUserId: string; created: boolean; emailVerified: boolean }>;
}

export type CoreClientErrorKind = "config" | "network" | "timeout" | "http" | "schema";

export class CoreClientError extends Error {
  override readonly name = "CoreClientError";
  constructor(
    readonly kind: CoreClientErrorKind,
    readonly status?: number,
  ) {
    super(`Studio request failed (${kind}${status ? ` ${status}` : ""})`);
  }
}

export const CORE_REQUEST_TIMEOUT_MS = 5_000;
/** How long a pulled Studio config is served without asking again. */
export const AI_CONFIG_TTL_MS = 60_000;

/** Explicit shapes: {apiKey: string, model} is a key; {apiKey: null, model} is "no key" (cleared). */
const aiConfigSchema = z.object({ apiKey: z.string().min(1).nullable(), model: z.string().min(1).nullish() });
const identitySchema = z.object({ coreUserId: z.string().min(1), created: z.boolean(), emailVerified: z.boolean() });

async function signedCall<T>(method: "GET" | "POST", path: string, payload: unknown, schema: z.ZodType<T>, okStatuses: Record<number, T> = {}): Promise<T> {
  let url: string;
  let headers: Record<string, string>;
  const body = payload === undefined ? "" : JSON.stringify(payload);
  try {
    const cfg = coreConfig();
    url = `${cfg.baseUrl}${path}`;
    // The signed path is pathname + raw query exactly as sent.
    const u = new URL(url);
    headers = { ...signRequest(method, u.pathname + u.search, body, cfg.outSecret), accept: "application/json" };
    if (body) headers["content-type"] = "application/json";
  } catch {
    throw new CoreClientError("config");
  }

  const signal = AbortSignal.timeout(CORE_REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, { method, headers, body: body || undefined, signal, cache: "no-store", redirect: "error" });
  } catch {
    throw new CoreClientError(signal.aborted ? "timeout" : "network");
  }
  if (res.status in okStatuses) {
    await res.body?.cancel().catch(() => {});
    return okStatuses[res.status]!;
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new CoreClientError("http", res.status);
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new CoreClientError(signal.aborted ? "timeout" : "schema");
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new CoreClientError("schema");
  return parsed.data;
}

export function createHttpCoreClient(): CoreClient {
  return {
    async getAiConfig() {
      const v = await signedCall("GET", "/api/retail/v1/ai-config", undefined, aiConfigSchema, { 404: { apiKey: null, model: null } });
      return { apiKey: v.apiKey, model: v.model ?? null };
    },
    ensureIdentity(email, name) {
      return signedCall("POST", "/api/retail/v1/identities", name === undefined ? { email } : { email, name }, identitySchema);
    },
  };
}

declare global {
  // Test-only override (see client-fake.ts); never read in production.
  var __coreClientFake: CoreClient | undefined;
}

/**
 * The configured client, or null in standalone mode (CORE_BASE_URL unset). A test fake set through
 * setCoreClientFake wins outside production only: production never selects it.
 */
export function getCoreClient(): CoreClient | null {
  if (process.env.NODE_ENV !== "production" && globalThis.__coreClientFake) return globalThis.__coreClientFake;
  if (!process.env.CORE_BASE_URL?.trim()) return null;
  return createHttpCoreClient();
}

type AiConfig = { apiKey: string; model: string | null };

/** After a Studio failure, Studio is not asked again for this long. */
export const NEGATIVE_TTL_MS = 15_000;
/** A pulled key is never served older than this, even when Studio keeps failing. */
export const MAX_STALE_MS = 60 * 60_000;

let cached: { value: AiConfig; at: number } | null = null;
let failedAt: number | null = null;
let inflight: Promise<"ok" | "none" | "failed"> | null = null;

/** Test hook: forget the cached Studio config. */
export function resetCoreKeyCache(): void {
  cached = null;
  failedAt = null;
  inflight = null;
}

function envConfig(): AiConfig | null {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return null;
  return { apiKey, model: process.env.INTAKE_MODEL?.trim() || null };
}

async function pull(client: CoreClient): Promise<"ok" | "none" | "failed"> {
  try {
    const v = await client.getAiConfig();
    failedAt = null;
    if (v.apiKey === null) {
      cached = null; // Studio definitively has no key: forget the old one
      return "none";
    }
    cached = { value: { apiKey: v.apiKey, model: v.model }, at: Date.now() };
    return "ok";
  } catch {
    failedAt = Date.now();
    return "failed";
  }
}

/**
 * The Anthropic key (and model) to use now. Standalone (no Studio configured): the environment key
 * as before. Linked: Studio's, cached for 60 s and shared by concurrent callers. A definitive "no
 * key" reply (404 or apiKey null) clears the cache and returns null. On a Studio failure Studio is
 * skipped for 15 s and the last value is served for at most 1 h; with none, the environment key
 * outside production and null in production (the provider then reports AI unavailable). Never
 * throws, never logs.
 */
export async function resolveAnthropicKey(): Promise<AiConfig | null> {
  const client = getCoreClient();
  if (!client) return envConfig();

  if (cached && Date.now() - cached.at < AI_CONFIG_TTL_MS) return cached.value;
  if (failedAt === null || Date.now() - failedAt >= NEGATIVE_TTL_MS) {
    inflight ??= pull(client).finally(() => {
      inflight = null;
    });
    const outcome = await inflight;
    if (outcome === "ok" && cached) return cached.value;
    if (outcome === "none") return null;
  }
  if (cached && Date.now() - cached.at < MAX_STALE_MS) return cached.value;
  return process.env.NODE_ENV === "production" ? null : envConfig();
}
