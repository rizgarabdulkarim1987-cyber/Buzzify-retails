import { isPackId, type PackId } from "./types";

/*
 * Which product answers on which address.
 *
 * PACK_HOSTS (optional) = comma-separated `host=PACKID` pairs, e.g.
 *   supermarket.buzzify.tech=SUPERMARKET,electronics.buzzify.tech=ELECTRONICS,clothing.buzzify.tech=CLOTHING
 * Each host is a bare lowercase host name: no scheme, no port, no path, no trailing dot. A host
 * appears once, a pack has at most one host, and APP_URL's host is never a pack host. A malformed
 * value throws PackHostsError (src/instrumentation.ts makes that stop a production start).
 * Unset or empty = one shared address (APP_URL) for every pack, the behaviour before packs.
 *
 * Trust: the current host is the request's Host header, and only when it is one of the hosts
 * configured here (or APP_URL's). X-Forwarded-Host and other forwarding headers are never read, so
 * no client header can make Retails build a URL on a host it does not own: an unknown Host falls
 * back to APP_URL, the same configured address every absolute URL used before. The proxy in front
 * (Caddy) passes the browser's Host through unchanged.
 */

export class PackHostsError extends Error {
  readonly variable = "PACK_HOSTS";
  constructor(detail: string) {
    // Names the variable and the rule broken; the value is not a secret but is not echoed either.
    super(`Invalid environment variable PACK_HOSTS: ${detail}`);
    this.name = "PackHostsError";
  }
}

const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const HOST_NAME = new RegExp(`^(?=.{1,253}$)${LABEL}(?:\\.${LABEL})*$`);

export function isHostName(value: string): boolean {
  return HOST_NAME.test(value);
}

/** The pairs of a PACK_HOSTS value, validated. Empty map for an unset or blank value. */
export function parsePackHosts(raw: string | undefined, appHost: string | null = null): ReadonlyMap<string, PackId> {
  const map = new Map<string, PackId>();
  if (raw === undefined || raw.trim() === "") return map;
  const packs = new Set<PackId>();
  for (const [i, part] of raw.split(",").entries()) {
    const entry = part.trim();
    const eq = entry.indexOf("=");
    if (eq <= 0 || eq !== entry.lastIndexOf("=")) throw new PackHostsError(`entry ${i + 1} is not host=PACKID`);
    const host = entry.slice(0, eq).trim();
    const pack = entry.slice(eq + 1).trim();
    if (!isHostName(host)) throw new PackHostsError(`entry ${i + 1}: the host must be a lowercase host name only (no scheme, port or path)`);
    if (!isPackId(pack)) throw new PackHostsError(`entry ${i + 1}: unknown pack (SUPERMARKET, ELECTRONICS or CLOTHING)`);
    if (map.has(host)) throw new PackHostsError(`entry ${i + 1}: the host appears twice`);
    if (packs.has(pack)) throw new PackHostsError(`entry ${i + 1}: the pack has a host already`);
    if (appHost !== null && host === appHost) throw new PackHostsError(`entry ${i + 1}: APP_URL's host is the shared address, not a pack host`);
    map.set(host, pack);
    packs.add(pack);
  }
  return map;
}

/** APP_URL as a URL, or null when it is unset or not an absolute http(s) URL. */
export function appUrl(): URL | null {
  const raw = process.env.APP_URL?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

let cached: { raw: string | undefined; app: string | null; map: ReadonlyMap<string, PackId> } | null = null;

/** The configured pack hosts (read lazily, so tests can set the env; re-parsed when it changes). */
export function packHosts(): ReadonlyMap<string, PackId> {
  const raw = process.env.PACK_HOSTS;
  const app = appUrl()?.hostname ?? null;
  if (!cached || cached.raw !== raw || cached.app !== app) cached = { raw, app, map: parsePackHosts(raw, app) };
  return cached.map;
}

/** Throws PackHostsError when PACK_HOSTS is malformed. Called at server start. */
export function assertPackHosts(): void {
  packHosts();
}

/** A Host header value reduced to its host name: lowercase, without port or trailing dot; null when unusable. */
export function hostNameOf(header: string | null | undefined): string | null {
  if (!header) return null;
  const value = header.trim().toLowerCase();
  if (value.length === 0 || value.length > 260) return null;
  if (value.startsWith("[")) return null; // IPv6 literal: never a configured host
  const name = value.replace(/:\d{1,5}$/, "").replace(/\.$/, "");
  return isHostName(name) ? name : null;
}

/** Scheme and port of APP_URL applied to a host (so dev keeps http and :3000). */
function originOn(host: string, app: URL): string {
  return `${app.protocol}//${host}${app.port ? `:${app.port}` : ""}`;
}

export type HostContext = {
  /** The host the request is served on, when it is a known host; null = unknown (treated as the shared address). */
  host: string | null;
  /** The pack that owns this host; null on the shared address (APP_URL) or an unknown host. */
  packId: PackId | null;
  /** The origin to build absolute URLs on (no trailing slash); null when APP_URL is missing too. */
  origin: string | null;
};

/** Where this request is served, from its Host header, trusted only when the host is configured. */
export function resolveHost(headers: Headers): HostContext {
  const app = appUrl();
  const name = hostNameOf(headers.get("host"));
  const packId = name ? (packHosts().get(name) ?? null) : null;
  if (packId && name && app) return { host: name, packId, origin: originOn(name, app) };
  if (app && name === app.hostname) return { host: name, packId: null, origin: app.origin };
  return { host: null, packId: null, origin: app ? app.origin : null };
}

/** The origin of a pack's own address, or null when PACK_HOSTS gives it none. */
export function packOrigin(packId: PackId): string | null {
  const app = appUrl();
  if (!app) return null;
  for (const [host, id] of packHosts()) if (id === packId) return originOn(host, app);
  return null;
}

/** Every origin Retails answers on: APP_URL's and each pack host's. */
export function knownOrigins(): string[] {
  const app = appUrl();
  if (!app) return [];
  return [app.origin, ...[...packHosts().keys()].map((h) => originOn(h, app))];
}
