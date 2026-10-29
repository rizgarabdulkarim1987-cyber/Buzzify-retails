import type { RuntimeDataModel } from "@prisma/client/runtime/client";
import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import { db } from "@/server/db";
import type { Actor } from "./actor";

/*
 * The business- and branch-scoped client. Every query a feature makes goes through here:
 *
 * - Reads, updates, deletes and upserts get the actor's filter ANDed into `where` (a caller's
 *   own where, OR or businessId can only narrow the result, never widen it).
 * - Creates force businessId from the actor; a different businessId, or (for branch-limited
 *   actors) a branchId outside actor.branchIds, throws ScopeError. Update data may not change
 *   businessId nor move a row to a branch outside the actor's branches.
 * - Nested writes (relation fields inside data) are refused. Relations reached through
 *   select/include/_count/where/orderBy must point at business-scoped models, and for
 *   branch-limited actors at models that are not branch-scoped.
 * - Unscoped models (Better Auth, platform tables) and raw SQL are refused.
 *
 * Classifying a model is one line: add it to SCOPE_RULES, UNSCOPED_MODELS or
 * NULLABLE_BUSINESS_MODELS. The compiler rejects an unclassified model (EVERY_MODEL_CLASSIFIED)
 * and tests/framework/scoped-db.test.ts checks the lists against the client's data model.
 */

type ModelName = Prisma.ModelName;
type Scalars<M extends ModelName> = Prisma.TypeMap["model"][M]["payload"]["scalars"];

/** Columns of model M that are a non-nullable string: the only columns that may carry scope. */
export type ScopeKey<M extends ModelName> = {
  [K in keyof Scalars<M>]-?: null extends Scalars<M>[K] ? never : Scalars<M>[K] extends string ? K : never;
}[keyof Scalars<M>] &
  string;

type ScopeRule<M extends ModelName> = {
  /** Column holding the business id (the primary key for RtBusiness itself). */
  business: ScopeKey<M>;
  /** Column holding the branch id; set for branch-owned rows (the primary key for RtBranch). */
  branch?: ScopeKey<M>;
  /** false when rows can never be created through the scoped client. */
  creatable?: false;
};

/** Business-scoped models. One line per model. */
const SCOPE_RULES = {
  RtBusiness: { business: "id", creatable: false },
  RtBranch: { business: "businessId", branch: "id" },
  RtLocation: { business: "businessId", branch: "branchId" },
  RtTerminal: { business: "businessId", branch: "branchId" },
  RtStaff: { business: "businessId" },
  RtStaffBranch: { business: "businessId", branch: "branchId" },
  RtCapability: { business: "businessId" },
  // Support grants: the owner creates and revokes them through ordinary actions.
  RtSupportGrant: { business: "businessId" },
  // Setup wizard progress (src/server/setup/progress.ts): one row per business and step.
  RtSetupProgress: { business: "businessId" },
  // Catalog (R1): business-level, shared by every branch (no branchId).
  RtCategory: { business: "businessId" },
  RtBrand: { business: "businessId" },
  RtProduct: { business: "businessId" },
  RtVariant: { business: "businessId" },
  RtUnit: { business: "businessId" },
  RtBarcode: { business: "businessId" },
  RtPriceList: { business: "businessId" },
  RtPrice: { business: "businessId" },
  RtCatalogCounter: { business: "businessId" },
  // Catalog import staging (Task 8/9): batches of an uploaded file and their rows.
  RtImportBatch: { business: "businessId" },
  RtImportRow: { business: "businessId" },
  // Saved import column maps (Task 9), per business.
  RtImportMappingPreset: { business: "businessId" },
  // Stock (R2). Documents, movements and balances belong to a branch's location: branch-scoped, so
  // a branch-limited actor only reaches its own branches. Lines follow their document (reached by
  // documentId); batches and the document counter are business-level.
  RtBatch: { business: "businessId" },
  RtStockDocument: { business: "businessId", branch: "branchId" },
  RtStockLine: { business: "businessId" },
  RtStockMovement: { business: "businessId", branch: "branchId" },
  RtStockBalance: { business: "businessId", branch: "branchId" },
  RtStockCounter: { business: "businessId" },
} as const satisfies { [M in ModelName]?: ScopeRule<M> };

/**
 * Models without a businessId column (Better Auth tables; RtIdempotency, keyed by a scope string
 * that is the businessId or 'platform'). Never reachable through scopedDb (base client only).
 */
const UNSCOPED = [
  "User",
  "Session",
  "Account",
  "Verification",
  "RtIdempotency",
  // Platform-managed subscription tables: most carry a businessId, but tenants never reach them.
  "RtPlan",
  "RtSubscription",
  "RtSubscriptionEvent",
  "RtSubscriptionPayment",
  "RtFeatureOverride",
  // Platform administrators (no businessId).
  "RtPlatformAdmin",
  // Owner invitations: carry a businessId, but hold token hashes and are only touched by platform
  // actions and acceptInvitation (src/server/admin). A tenant must never list or read them.
  "RtInvitation",
  // Failed sign-in attempts (hashed keys, no businessId); only src/server/auth/login-throttle.ts touches them.
  "RtLoginAttempt",
] as const satisfies readonly ModelName[];

/** The UNSCOPED models that may carry a businessId column (platform-managed; the framework reads them with the base client). */
const PLATFORM_MANAGED = [
  "RtPlan",
  "RtSubscription",
  "RtSubscriptionEvent",
  "RtSubscriptionPayment",
  "RtFeatureOverride",
  "RtInvitation",
] as const satisfies readonly (typeof UNSCOPED)[number][];

/**
 * Models whose businessId is nullable (rows that may belong to no business, e.g. audit
 * entries of platform actions). Never reachable through scopedDb; the framework reads them with the base client.
 */
const NULLABLE_BUSINESS = ["RtAuditLog"] as const satisfies readonly ModelName[];

type Classified = keyof typeof SCOPE_RULES | (typeof UNSCOPED)[number] | (typeof NULLABLE_BUSINESS)[number];
type Unclassified = Exclude<ModelName, Classified>;
/** Compile-time guard: fails typecheck while a model is missing from the lists above. */
export const EVERY_MODEL_CLASSIFIED: [Unclassified] extends [never] ? true : { unclassified: Unclassified } = true;

/** The checked rules, widened for lookup by runtime model name. */
type Rule = { business: string; branch?: string; creatable?: false };

/**
 * Own-property lookup. Every name-keyed lookup in this file goes through it (or a Map/Set), so
 * inherited Object.prototype keys such as `constructor` or `__proto__` never match.
 */
function own<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}
const RULES: Readonly<Record<string, Rule | undefined>> = SCOPE_RULES;

export const BUSINESS_SCOPED_MODELS: readonly ModelName[] = Object.freeze(Object.keys(SCOPE_RULES) as ModelName[]);
export const BRANCH_SCOPED_MODELS: readonly ModelName[] = Object.freeze(
  BUSINESS_SCOPED_MODELS.filter((m) => own(RULES, m)?.branch !== undefined),
);
export const UNSCOPED_MODELS: readonly ModelName[] = Object.freeze([...UNSCOPED]);
export const PLATFORM_MANAGED_MODELS: readonly ModelName[] = Object.freeze([...PLATFORM_MANAGED]);
export const NULLABLE_BUSINESS_MODELS: readonly ModelName[] = Object.freeze([...NULLABLE_BUSINESS]);

export type ScopeErrorCode =
  | "INVALID_ACTOR"
  | "UNSCOPED_MODEL"
  | "RAW_QUERY"
  | "UNSUPPORTED_OPERATION"
  | "FOREIGN_BUSINESS"
  | "FOREIGN_BRANCH"
  | "CREATE_NOT_ALLOWED"
  | "NESTED_WRITE"
  | "UNKNOWN_FIELD"
  | "BRANCH_RELATION"
  | "UNSCOPED_RELATION"
  // Raised when a read touches a model outside the set a support grant's scopes allow.
  | "MODEL_NOT_IN_SCOPE"
  // Raised by the read-only wrapper a support actor gets (src/server/admin/support.ts).
  | "READ_ONLY_ACTOR";

export class ScopeError extends Error {
  override readonly name = "ScopeError";
  constructor(
    readonly code: ScopeErrorCode,
    detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

// ---------------------------------------------------------------------------------------------
// Data model (field names and relation targets) read from the generated client.

export type ModelFields = { scalars: string[]; relations: Record<string, string> };

/**
 * Scalar columns and relation targets of every model. Prisma 7's `prisma-client` generator no
 * longer emits `Prisma.dmmf`; the client carries the same data model (pruned to names, kinds and
 * types) as `_runtimeDataModel`. Fails closed if a Prisma upgrade removes it.
 */
export function modelFields(client: unknown = db): Record<string, ModelFields> {
  const runtime = (client as { _runtimeDataModel?: RuntimeDataModel })._runtimeDataModel;
  if (!runtime?.models) throw new Error("scopedDb: the Prisma client exposes no runtime data model");
  const out: Record<string, ModelFields> = Object.create(null);
  for (const [name, model] of Object.entries(runtime.models)) {
    const fields: ModelFields = { scalars: [], relations: Object.create(null) };
    for (const f of model.fields) {
      if (f.kind === "object") fields.relations[f.name] = f.type;
      else fields.scalars.push(f.name);
    }
    out[name] = fields;
  }
  return out;
}

let cachedFields: Record<string, ModelFields> | undefined;
function fieldsOf(model: string): ModelFields {
  cachedFields ??= modelFields();
  const f = own(cachedFields, model);
  if (!f) throw new ScopeError("UNSCOPED_MODEL", model);
  return f;
}

/** Checks the lists against a data model; both arrays are empty when every model is classified correctly. */
export function classifyModels(fields: Record<string, ModelFields>): { unclassified: string[]; misclassified: string[] } {
  const unclassified: string[] = [];
  const misclassified: string[] = [];
  const lists: [string, readonly string[]][] = [
    ["business-scoped", BUSINESS_SCOPED_MODELS],
    ["unscoped", UNSCOPED_MODELS],
    ["nullable-business", NULLABLE_BUSINESS_MODELS],
  ];
  for (const [model, { scalars }] of Object.entries(fields)) {
    const listed = lists.filter(([, l]) => l.includes(model)).map(([n]) => n);
    if (listed.length === 0) {
      unclassified.push(model);
      continue;
    }
    if (listed.length > 1) misclassified.push(`${model}: listed as ${listed.join(" and ")}`);
    const rule = own(RULES, model);
    if (rule) {
      for (const key of [rule.business, rule.branch]) {
        if (key !== undefined && !scalars.includes(key)) misclassified.push(`${model}: scope column ${key} is missing`);
      }
      if (scalars.includes("branchId") && rule.branch === undefined) {
        misclassified.push(`${model}: has a branchId column but is not branch-scoped`);
      }
    }
    if (
      UNSCOPED_MODELS.includes(model as ModelName) &&
      !PLATFORM_MANAGED_MODELS.includes(model as ModelName) &&
      scalars.includes("businessId")
    ) {
      misclassified.push(`${model}: has a businessId column but is listed as unscoped`);
    }
    if (NULLABLE_BUSINESS_MODELS.includes(model as ModelName) && !scalars.includes("businessId")) {
      misclassified.push(`${model}: listed as nullable-business but has no businessId column`);
    }
  }
  for (const [name, list] of lists) {
    for (const model of list) if (!own(fields, model)) misclassified.push(`${model}: listed as ${name} but is not a model`);
  }
  return { unclassified, misclassified };
}

// ---------------------------------------------------------------------------------------------
// Argument rewriting (shared by the extension and the transaction wrapper).

type Scope = { readonly businessId: string; readonly branchIds: readonly string[] | "ALL" };
type Args = Record<string, unknown>;

const isObject = (v: unknown): v is Args => typeof v === "object" && v !== null && !Array.isArray(v);
const toArray = (v: unknown): unknown[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

const WHERE_OPS = new Set([
  "findMany",
  "findFirst",
  "findFirstOrThrow",
  "findUnique",
  "findUniqueOrThrow",
  "count",
  "aggregate",
  "groupBy",
  "update",
  "updateMany",
  "updateManyAndReturn",
  "delete",
  "deleteMany",
  "upsert",
]);
const CREATE_OPS = new Set(["create", "createMany", "createManyAndReturn"]);
const UPDATE_OPS = new Set(["update", "updateMany", "updateManyAndReturn"]);
const LOGICAL = new Set(["AND", "OR", "NOT"]);
const RELATION_FILTERS = new Set(["some", "every", "none", "is", "isNot"]);

function snapshot(actor: Actor): Scope {
  if (!isObject(actor) || typeof actor.businessId !== "string" || actor.businessId === "") {
    throw new ScopeError("INVALID_ACTOR", "businessId is required");
  }
  const { businessId, branchIds } = actor;
  if (branchIds === "ALL") return Object.freeze({ businessId, branchIds });
  if (!Array.isArray(branchIds) || branchIds.some((b) => typeof b !== "string")) {
    throw new ScopeError("INVALID_ACTOR", "branchIds must be 'ALL' or a list of ids");
  }
  return Object.freeze({ businessId, branchIds: Object.freeze([...branchIds]) });
}

function ruleOf(model: string): Rule {
  const rule = own(RULES, model);
  if (!rule) throw new ScopeError("UNSCOPED_MODEL", model);
  return rule;
}

function scopeFilter(scope: Scope, rule: Rule): Args {
  const filter: Args = { [rule.business]: scope.businessId };
  if (rule.branch !== undefined && scope.branchIds !== "ALL") filter[rule.branch] = { in: [...scope.branchIds] };
  return filter;
}

/** ANDs the scope into a where (works for unique wheres too: their unique fields stay at the top). */
function mergeWhere(where: unknown, filter: Args): Args {
  if (where === undefined) return filter;
  if (!isObject(where)) throw new ScopeError("UNSUPPORTED_OPERATION", "where must be an object");
  return { ...where, AND: [...toArray(where.AND), filter] };
}

function checkTarget(scope: Scope, from: string, field: string, target: string): void {
  const rule = own(RULES, target);
  if (!rule) throw new ScopeError("UNSCOPED_RELATION", `${from}.${field} -> ${target}`);
  if (rule.branch !== undefined && scope.branchIds !== "ALL") {
    throw new ScopeError("BRANCH_RELATION", `${from}.${field} -> ${target}`);
  }
}

function walkWhere(scope: Scope, model: string, where: unknown): void {
  if (Array.isArray(where)) return where.forEach((w) => walkWhere(scope, model, w));
  if (!isObject(where)) return;
  const { relations } = fieldsOf(model);
  for (const [key, value] of Object.entries(where)) {
    if (LOGICAL.has(key)) {
      walkWhere(scope, model, value);
      continue;
    }
    const target = own(relations, key);
    if (target === undefined) continue;
    checkTarget(scope, model, key, target);
    if (!isObject(value)) continue;
    const direct: Args = {};
    for (const [k, v] of Object.entries(value)) {
      if (RELATION_FILTERS.has(k)) walkWhere(scope, target, v);
      else direct[k] = v;
    }
    walkWhere(scope, target, direct);
  }
}

function walkOrderBy(scope: Scope, model: string, orderBy: unknown): void {
  if (Array.isArray(orderBy)) return orderBy.forEach((o) => walkOrderBy(scope, model, o));
  if (!isObject(orderBy)) return;
  const { relations } = fieldsOf(model);
  for (const [key, value] of Object.entries(orderBy)) {
    const target = own(relations, key);
    if (target === undefined) continue;
    checkTarget(scope, model, key, target);
    walkOrderBy(scope, target, value);
  }
}

function walkSelection(scope: Scope, model: string, selection: unknown): void {
  if (!isObject(selection)) return;
  const { relations } = fieldsOf(model);
  for (const [key, value] of Object.entries(selection)) {
    if (!value) continue;
    if (key === "_count") {
      // `_count: true` counts every list relation; the runtime data model does not mark lists, so
      // every relation is checked (stricter than needed for to-one relations).
      const counted = isObject(value) && isObject(value.select) ? value.select : value === true ? relations : {};
      for (const [rel, sub] of Object.entries(counted)) {
        const target = own(relations, rel);
        if (!sub || target === undefined) continue;
        checkTarget(scope, model, rel, target);
        if (isObject(sub)) walkWhere(scope, target, sub.where);
      }
      continue;
    }
    const target = own(relations, key);
    if (target === undefined) continue;
    checkTarget(scope, model, key, target);
    if (isObject(value)) walkArgs(scope, target, value);
  }
}

function walkArgs(scope: Scope, model: string, args: Args): void {
  walkSelection(scope, model, args.select);
  walkSelection(scope, model, args.include);
  walkWhere(scope, model, args.where);
  walkOrderBy(scope, model, args.orderBy);
}

/**
 * Every model a read reaches: `model` itself plus each model named through select, include,
 * _count, where (including AND/OR/NOT and relation filters) and orderBy, however deeply nested.
 * Used by the support read-only wrapper to refuse models outside a grant's scopes. Fails closed:
 * an unknown model throws ScopeError('UNSCOPED_MODEL').
 */
export function modelsReached(model: string, args: unknown): Set<string> {
  const seen = new Set<string>([model]);
  const visitWhere = (m: string, where: unknown): void => {
    if (Array.isArray(where)) return where.forEach((w) => visitWhere(m, w));
    if (!isObject(where)) return;
    const { relations } = fieldsOf(m);
    for (const [key, value] of Object.entries(where)) {
      if (LOGICAL.has(key)) {
        visitWhere(m, value);
        continue;
      }
      const target = own(relations, key);
      if (target === undefined) continue;
      seen.add(target);
      if (!isObject(value)) continue;
      const direct: Args = {};
      for (const [k, v] of Object.entries(value)) {
        if (RELATION_FILTERS.has(k)) visitWhere(target, v);
        else direct[k] = v;
      }
      visitWhere(target, direct);
    }
  };
  const visitOrderBy = (m: string, orderBy: unknown): void => {
    if (Array.isArray(orderBy)) return orderBy.forEach((o) => visitOrderBy(m, o));
    if (!isObject(orderBy)) return;
    const { relations } = fieldsOf(m);
    for (const [key, value] of Object.entries(orderBy)) {
      const target = own(relations, key);
      if (target === undefined) continue;
      seen.add(target);
      visitOrderBy(target, value);
    }
  };
  const visitSelection = (m: string, selection: unknown): void => {
    if (!isObject(selection)) return;
    const { relations } = fieldsOf(m);
    for (const [key, value] of Object.entries(selection)) {
      if (!value) continue;
      if (key === "_count") {
        const counted = isObject(value) && isObject(value.select) ? value.select : value === true ? relations : {};
        for (const [rel, sub] of Object.entries(counted)) {
          const target = own(relations, rel);
          if (!sub || target === undefined) continue;
          seen.add(target);
          if (isObject(sub)) visitWhere(target, sub.where);
        }
        continue;
      }
      const target = own(relations, key);
      if (target === undefined) continue;
      seen.add(target);
      if (isObject(value)) visitArgs(target, value);
    }
  };
  const visitArgs = (m: string, a: Args): void => {
    visitSelection(m, a.select);
    visitSelection(m, a.include);
    visitWhere(m, a.where);
    visitOrderBy(m, a.orderBy);
  };
  if (isObject(args)) visitArgs(model, args);
  return seen;
}

function checkDataKeys(model: string, data: Args): void {
  const { scalars, relations } = fieldsOf(model);
  for (const key of Object.keys(data)) {
    if (own(relations, key) !== undefined) throw new ScopeError("NESTED_WRITE", `${model}.${key}`);
    if (!scalars.includes(key)) throw new ScopeError("UNKNOWN_FIELD", `${model}.${key}`);
  }
}

/** The plain value of a scalar write (`x` or `{ set: x }`). */
function written(value: unknown): unknown {
  return isObject(value) && Object.keys(value).length === 1 && "set" in value ? value.set : value;
}

function inBranches(scope: Scope, value: unknown): boolean {
  return scope.branchIds === "ALL" || (typeof value === "string" && scope.branchIds.includes(value));
}

function scopeCreateData(scope: Scope, model: string, rule: Rule, data: unknown): Args {
  if (rule.creatable === false) throw new ScopeError("CREATE_NOT_ALLOWED", model);
  if (!isObject(data)) throw new ScopeError("UNSUPPORTED_OPERATION", `${model}: create data must be an object`);
  checkDataKeys(model, data);
  if (data[rule.business] !== undefined && data[rule.business] !== scope.businessId) {
    throw new ScopeError("FOREIGN_BUSINESS", model);
  }
  if (rule.branch !== undefined && !inBranches(scope, data[rule.branch])) {
    throw new ScopeError("FOREIGN_BRANCH", model);
  }
  return { ...data, [rule.business]: scope.businessId };
}

function checkUpdateData(scope: Scope, model: string, rule: Rule, data: unknown): void {
  if (!isObject(data)) throw new ScopeError("UNSUPPORTED_OPERATION", `${model}: update data must be an object`);
  checkDataKeys(model, data);
  if (data[rule.business] !== undefined && written(data[rule.business]) !== scope.businessId) {
    throw new ScopeError("FOREIGN_BUSINESS", model);
  }
  if (rule.branch !== undefined && data[rule.branch] !== undefined && !inBranches(scope, written(data[rule.branch]))) {
    throw new ScopeError("FOREIGN_BRANCH", model);
  }
}

/** Rewrites one model operation's arguments for the scope, or throws ScopeError. Never mutates `args`. */
function scopeArgs(scope: Scope, model: string, operation: string, args: unknown): Args {
  const rule = ruleOf(model);
  if (args !== undefined && !isObject(args)) throw new ScopeError("UNSUPPORTED_OPERATION", `${model}.${operation}`);
  const out: Args = { ...args };
  walkArgs(scope, model, out);

  if (CREATE_OPS.has(operation)) {
    out.data = Array.isArray(out.data)
      ? out.data.map((d) => scopeCreateData(scope, model, rule, d))
      : scopeCreateData(scope, model, rule, out.data);
    return out;
  }
  if (!WHERE_OPS.has(operation)) throw new ScopeError("UNSUPPORTED_OPERATION", `${model}.${operation}`);
  out.where = mergeWhere(out.where, scopeFilter(scope, rule));
  if (UPDATE_OPS.has(operation)) checkUpdateData(scope, model, rule, out.data);
  if (operation === "upsert") {
    out.create = scopeCreateData(scope, model, rule, out.create);
    checkUpdateData(scope, model, rule, out.update);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Clients.

/** Delegate property name (camelCase) to model name. A Map, so inherited keys never match. */
const DELEGATE_MODELS: ReadonlyMap<string, string> = new Map(
  Object.values(Prisma.ModelName).map((m) => [m.charAt(0).toLowerCase() + m.slice(1), m]),
);

/** The model operations a guarded delegate exposes; every other delegate key is undefined. */
const MODEL_OPERATIONS = new Set([...WHERE_OPS, ...CREATE_OPS]);
const RAW_METHODS = new Set([
  "$queryRaw",
  "$executeRaw",
  "$queryRawUnsafe",
  "$executeRawUnsafe",
  "$queryRawTyped",
  "$runCommandRaw",
]);

const UNDERLYING = new WeakMap<object, PromiseLike<unknown>>();

/**
 * A result handed to callers: awaitable and lazy like a PrismaPromise, but WITHOUT Prisma's fluent
 * relation methods (`findFirst().business().staff()`), which would build new queries on the base
 * client that never pass through the scope rewrite. Never return the raw PrismaPromise.
 */
export function plainPromise<T>(source: PromiseLike<T>): PromiseLike<T> & Promise<T> {
  const wrapper = {
    then: (ok?: never, fail?: never) => source.then(ok, fail),
    catch: (fail?: never) => source.then(undefined, fail),
    finally: (fn?: () => void) => Promise.resolve(source).finally(fn),
    [Symbol.toStringTag]: "Promise",
  } as unknown as PromiseLike<T> & Promise<T>;
  UNDERLYING.set(wrapper, source);
  return Object.freeze(wrapper);
}

/** The Prisma promise behind a plainPromise (the array form of $transaction needs the real ones). */
const unwrapPlain = (p: unknown): unknown =>
  typeof p === "object" && p !== null ? (UNDERLYING.get(p) ?? p) : p;

/**
 * Which client a guard fronts:
 * - "client": a full client carrying the scope extension (the extension rewrites every query);
 * - "extendedTx": the interactive-transaction client of such a client (same extension);
 * - "tx": a handed-in base transaction client (Prisma 7 denies `$extends` on it), so the guard
 *   itself runs scopeArgs before every call.
 */
type GuardKind = "client" | "extendedTx" | "tx";

/**
 * Allow-list facade over a Prisma client. The Proxy's target is an empty object, so `ownKeys`,
 * `getOwnPropertyDescriptor`, `has` and `getPrototypeOf` reveal nothing of the underlying
 * client (util.inspect prints the empty target). `get` returns only: model delegates (themselves allow-listed to the model operations),
 * `$transaction` (full client only, with the callback's tx guarded too), raw SQL methods that
 * reject with ScopeError('RAW_QUERY'), `$transaction` on a transaction that rejects with
 * ScopeError('UNSUPPORTED_OPERATION'), and Symbol.toStringTag. Every other key (all `_` internals
 * such as `_appliedParent`, `$extends`, `$connect`, `then`, unknown symbols) is undefined.
 */
function guard(client: object, scope: Scope, kind: GuardKind): object {
  const delegates = new Map<string, object>();
  const rejecting = (code: ScopeErrorCode, what: string) => () => Promise.reject(new ScopeError(code, what));

  const delegateFor = (key: string, model: string): object => {
    const facade = Object.create(null) as object;
    return new Proxy(facade, {
      get(_t, op) {
        if (typeof op !== "string" || !MODEL_OPERATIONS.has(op)) return undefined;
        return (args?: unknown) => {
          // Resolve the delegate per call so nothing is cached outside the closure.
          const delegate = Reflect.get(client, key) as Record<string, (a: unknown) => unknown>;
          if (kind !== "tx") return plainPromise(delegate[op]!.call(delegate, args) as PromiseLike<unknown>);
          let scoped: Args;
          try {
            scoped = scopeArgs(scope, model, op, args);
          } catch (err) {
            return Promise.reject(err);
          }
          return plainPromise(delegate[op]!.call(delegate, scoped) as PromiseLike<unknown>);
        };
      },
    });
  };

  const transaction = (arg: unknown, options?: unknown): unknown => {
    const base = client as { $transaction: (a: unknown, o?: unknown) => Promise<unknown> };
    if (typeof arg === "function") {
      return base.$transaction((tx: object) => (arg as (t: object) => unknown)(guard(tx, scope, "extendedTx")), options);
    }
    // Array form: the operations are promises built from this facade's own delegates.
    if (Array.isArray(arg)) return base.$transaction(arg.map(unwrapPlain), options);
    return Promise.reject(new ScopeError("UNSUPPORTED_OPERATION", "$transaction"));
  };

  const facade = Object.create(null) as object;
  return new Proxy(facade, {
    get(_t, prop) {
      if (prop === Symbol.toStringTag) return "ScopedDb";
      if (typeof prop !== "string") return undefined;
      const model = DELEGATE_MODELS.get(prop);
      if (model !== undefined) {
        let d = delegates.get(prop);
        if (!d) delegates.set(prop, (d = delegateFor(prop, model)));
        return d;
      }
      if (RAW_METHODS.has(prop)) return rejecting("RAW_QUERY", prop);
      if (prop === "$transaction") {
        return kind === "client" ? transaction : rejecting("UNSUPPORTED_OPERATION", "nested $transaction");
      }
      return undefined;
    },
  });
}

function extendClient(client: PrismaClient, scope: Scope): PrismaClient {
  const extended = client.$extends({
    name: "scopedDb",
    query: {
      async $allOperations({ model, operation, args, query }) {
        // Raw SQL ($queryRaw, $executeRaw and the Unsafe variants) has no model.
        if (!model) throw new ScopeError("RAW_QUERY", operation);
        return query(scopeArgs(scope, model, operation, args) as typeof args);
      },
    },
  });
  return guard(extended, scope, "client") as PrismaClient;
}

/** A handed-in base transaction client: guarded, with scopeArgs run by the guard itself. */
function wrapTransaction(tx: Prisma.TransactionClient, scope: Scope): Prisma.TransactionClient {
  return guard(tx, scope, "tx") as Prisma.TransactionClient;
}

/**
 * A client that can only see and change the actor's business (and, unless branchIds is 'ALL',
 * the actor's branches). Pass a transaction client to scope work inside an existing transaction;
 * `$transaction` on the returned full client also stays scoped. The actor is copied on creation.
 */
export function scopedDb(actor: Actor, client?: PrismaClient): PrismaClient;
export function scopedDb(actor: Actor, client: Prisma.TransactionClient): Prisma.TransactionClient;
export function scopedDb(
  actor: Actor,
  client: PrismaClient | Prisma.TransactionClient = db,
): PrismaClient | Prisma.TransactionClient {
  const scope = snapshot(actor);
  if (typeof (client as { $extends?: unknown }).$extends === "function") {
    return extendClient(client as PrismaClient, scope);
  }
  return wrapTransaction(client, scope);
}
