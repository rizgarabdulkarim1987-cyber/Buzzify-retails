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
} as const satisfies { [M in ModelName]?: ScopeRule<M> };

/** Models without a businessId column. Never reachable through scopedDb (base client only). */
const UNSCOPED = ["User", "Session", "Account", "Verification"] as const satisfies readonly ModelName[];

/**
 * Models whose businessId is nullable (rows that may belong to no business, e.g. idempotency
 * keys). Never reachable through scopedDb; the framework reads them with the base client.
 */
const NULLABLE_BUSINESS = [] as const satisfies readonly ModelName[];

type Classified = keyof typeof SCOPE_RULES | (typeof UNSCOPED)[number] | (typeof NULLABLE_BUSINESS)[number];
type Unclassified = Exclude<ModelName, Classified>;
/** Compile-time guard: fails typecheck while a model is missing from the lists above. */
export const EVERY_MODEL_CLASSIFIED: [Unclassified] extends [never] ? true : { unclassified: Unclassified } = true;

/** The checked rules, widened for lookup by runtime model name. */
type Rule = { business: string; branch?: string; creatable?: false };
const RULES: Readonly<Record<string, Rule | undefined>> = SCOPE_RULES;

export const BUSINESS_SCOPED_MODELS: readonly ModelName[] = Object.freeze(Object.keys(SCOPE_RULES) as ModelName[]);
export const BRANCH_SCOPED_MODELS: readonly ModelName[] = Object.freeze(
  BUSINESS_SCOPED_MODELS.filter((m) => RULES[m]?.branch !== undefined),
);
export const UNSCOPED_MODELS: readonly ModelName[] = Object.freeze([...UNSCOPED]);
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
  | "UNSCOPED_RELATION";

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
  const out: Record<string, ModelFields> = {};
  for (const [name, model] of Object.entries(runtime.models)) {
    const fields: ModelFields = { scalars: [], relations: {} };
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
  const f = cachedFields[model];
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
    const rule = RULES[model];
    if (rule) {
      for (const key of [rule.business, rule.branch]) {
        if (key !== undefined && !scalars.includes(key)) misclassified.push(`${model}: scope column ${key} is missing`);
      }
      if (scalars.includes("branchId") && rule.branch === undefined) {
        misclassified.push(`${model}: has a branchId column but is not branch-scoped`);
      }
    }
    if (UNSCOPED_MODELS.includes(model as ModelName) && scalars.includes("businessId")) {
      misclassified.push(`${model}: has a businessId column but is listed as unscoped`);
    }
    if (NULLABLE_BUSINESS_MODELS.includes(model as ModelName) && !scalars.includes("businessId")) {
      misclassified.push(`${model}: listed as nullable-business but has no businessId column`);
    }
  }
  for (const [name, list] of lists) {
    for (const model of list) if (!fields[model]) misclassified.push(`${model}: listed as ${name} but is not a model`);
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
  const rule = RULES[model];
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
  const rule = RULES[target];
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
    const target = relations[key];
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
    const target = relations[key];
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
        const target = relations[rel];
        if (!sub || target === undefined) continue;
        checkTarget(scope, model, rel, target);
        if (isObject(sub)) walkWhere(scope, target, sub.where);
      }
      continue;
    }
    const target = relations[key];
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

function checkDataKeys(model: string, data: Args): void {
  const { scalars, relations } = fieldsOf(model);
  for (const key of Object.keys(data)) {
    if (relations[key] !== undefined) throw new ScopeError("NESTED_WRITE", `${model}.${key}`);
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
  return extended as unknown as PrismaClient;
}

const DELEGATE_MODELS: Readonly<Record<string, string>> = Object.fromEntries(
  Object.values(Prisma.ModelName).map((m) => [m.charAt(0).toLowerCase() + m.slice(1), m]),
);

/**
 * Prisma 7 denies `$extends` on interactive-transaction clients, so a handed-in `tx` is wrapped
 * in a Proxy that runs the same scopeArgs on every model call and refuses every `$` method
 * (raw SQL, nested $transaction).
 */
function wrapTransaction(tx: Prisma.TransactionClient, scope: Scope): Prisma.TransactionClient {
  const delegates = new Map<string, unknown>();
  const wrapDelegate = (delegate: object, model: string) =>
    new Proxy(delegate, {
      get(target, prop) {
        const value: unknown = Reflect.get(target, prop);
        if (typeof prop !== "string" || typeof value !== "function") return value;
        return (args?: unknown) => {
          let scoped: Args;
          try {
            scoped = scopeArgs(scope, model, prop, args);
          } catch (err) {
            return Promise.reject(err);
          }
          return (value as (a: Args) => unknown).call(target, scoped);
        };
      },
    });
  return new Proxy(tx, {
    get(target, prop, receiver) {
      if (typeof prop === "string") {
        const model = DELEGATE_MODELS[prop];
        if (model !== undefined) {
          if (!delegates.has(prop)) delegates.set(prop, wrapDelegate(Reflect.get(target, prop) as object, model));
          return delegates.get(prop);
        }
        if (prop.startsWith("$")) {
          const code: ScopeErrorCode = /raw/i.test(prop) ? "RAW_QUERY" : "UNSUPPORTED_OPERATION";
          return () => Promise.reject(new ScopeError(code, prop));
        }
      }
      return Reflect.get(target, prop, receiver);
    },
  });
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
