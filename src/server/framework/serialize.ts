import { createHash } from "node:crypto";

/*
 * The one serializer behind the payload hash, the audit `changes` and the stored idempotency
 * result. Plain JSON cannot carry the project's money type (bigint minor units) or Dates, so:
 *
 *   bigint -> {"$bigint": "123"}      Date -> {"$date": "<iso>"}
 *
 * decode() reverses both, so a replay returns values equal to the first run. A user key that
 * starts with "$" gets one more "$" prepended on encode (and stripped on decode), so a user
 * object shaped like a tag ({"$bigint":"1"} becomes {"$$bigint":"1"}) is never read as a real one.
 * undefined (and missing keys) are dropped from objects, like JSON; in arrays they become null.
 * Map, Set, class instances, functions, symbols, NaN/Infinity and invalid Dates are rejected
 * with SerializationError rather than silently collapsed.
 */

export class SerializationError extends Error {
  override readonly name = "SerializationError";
  constructor(detail: string) {
    super(`Cannot serialize value: ${detail}`);
  }
}

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function encodeKey(key: string): string {
  return key.startsWith("$") ? `$${key}` : key;
}

function decodeKey(key: string): string {
  return key.startsWith("$$") ? key.slice(1) : key;
}

function encodeAt(value: unknown, path: string): Json {
  switch (typeof value) {
    case "undefined":
      return null;
    case "boolean":
    case "string":
      return value;
    case "number":
      if (!Number.isFinite(value)) throw new SerializationError(`non-finite number at ${path}`);
      return value;
    case "bigint":
      return { $bigint: value.toString() };
    case "function":
    case "symbol":
      throw new SerializationError(`${typeof value} at ${path}`);
  }
  if (value === null) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new SerializationError(`invalid Date at ${path}`);
    return { $date: value.toISOString() };
  }
  if (Array.isArray(value)) return value.map((v, i) => encodeAt(v, `${path}[${i}]`));
  const proto = Object.getPrototypeOf(value) as unknown;
  if (proto !== Object.prototype && proto !== null) {
    throw new SerializationError(`${(value as object).constructor?.name ?? "object"} at ${path}`);
  }
  const out: { [key: string]: Json } = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v === undefined) continue;
    out[encodeKey(k)] = encodeAt(v, `${path}.${k}`);
  }
  return out;
}

/** Value to a JSON-safe tree (store it, or JSON.stringify it). Throws SerializationError. */
export function encode(value: unknown): Json {
  return encodeAt(value, "$");
}

/** Reverses encode(): tagged bigints and Dates come back as bigint and Date. */
export function decode(json: unknown): unknown {
  if (Array.isArray(json)) return json.map(decode);
  if (json === null || typeof json !== "object") return json;
  const entries = Object.entries(json as Record<string, unknown>);
  if (entries.length === 1) {
    const [[k, v]] = entries as [[string, unknown]];
    if (k === "$bigint" && typeof v === "string") return BigInt(v);
    if (k === "$date" && typeof v === "string") return new Date(v);
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of entries) out[decodeKey(k)] = decode(v);
  return out;
}

function sortKeys(value: Json): Json {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const out: { [key: string]: Json } = {};
    for (const k of Object.keys(value).sort()) out[k] = sortKeys(value[k]!);
    return out;
  }
  return value;
}

/** sha256 of the canonical (key-sorted) encoding of `value`. Throws SerializationError. */
export function canonicalHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(sortKeys(encode(value)))).digest("hex");
}
