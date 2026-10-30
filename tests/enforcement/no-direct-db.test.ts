import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Feature code reaches the database only through scopedDb. This test fails when a file outside
 * the allowed folders imports the base client (`@/server/db`, by alias or relative path) or the
 * generated `PrismaClient` as a value (for direct instantiation).
 */

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SCANNED_DIRS = ["src/app", "src/server"];
const ALLOWED_FILES = ["src/server/db.ts"];
const ALLOWED_DIRS = ["src/server/framework/", "src/server/auth/", "src/server/admin/"];

const BASE_DB = "src/server/db";
/**
 * Framework internals that hand out the base transaction client (platform-tx) or run base
 * transactions (transaction). Importable only from src/server/framework/, not even from the
 * folders exempt from the base-db rule.
 */
const FRAMEWORK_ONLY = ["src/server/framework/platform-tx", "src/server/framework/transaction"];
const FRAMEWORK_DIR = "src/server/framework/";
const PRISMA_INTERNALS = /\._(appliedParent|originalClient|createItxClient|engine|request|executeRequest)\b/g;
const GENERATED_CLIENT = ["src/generated/prisma/client", "src/generated/prisma"];

/** True when this repo-relative (posix) path may use the base client. */
export function isExempt(file: string): boolean {
  return ALLOWED_FILES.includes(file) || ALLOWED_DIRS.some((dir) => file.startsWith(dir));
}

/** Repo-relative module path a specifier points at, without extension; null for packages. */
function resolveSpecifier(file: string, spec: string): string | null {
  let target: string;
  if (spec.startsWith("@/")) target = `src/${spec.slice(2)}`;
  else if (spec.startsWith("./") || spec.startsWith("../")) target = path.posix.join(path.posix.dirname(file), spec);
  else return spec === "@prisma/client" ? "@prisma/client" : null;
  target = path.posix.normalize(target).replace(/\/$/, "");
  return target.replace(/\.(tsx?|mts|cts|jsx?|mjs|cjs)$/, "").replace(/\/index$/, "");
}

type ImportSite = { spec: string; clause: string | null; typeOnly: boolean };

function importSites(content: string): ImportSite[] {
  const sites: ImportSite[] = [];
  const fromRe = /\b(import|export)\s+(type\s+)?([\s\S]*?)\s*from\s*["']([^"']+)["']/g;
  for (const m of content.matchAll(fromRe)) sites.push({ spec: m[4]!, clause: m[3]!, typeOnly: Boolean(m[2]) });
  const bareRe = /\bimport\s*["']([^"']+)["']/g;
  for (const m of content.matchAll(bareRe)) sites.push({ spec: m[1]!, clause: null, typeOnly: false });
  const callRe = /\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const m of content.matchAll(callRe)) sites.push({ spec: m[1]!, clause: null, typeOnly: false });
  return sites;
}

/** True when an import clause brings in PrismaClient as a value (not `import type`, not `type PrismaClient`). */
function importsPrismaClientValue(clause: string | null): boolean {
  if (clause === null) return true; // dynamic import / require / export * expose the class
  if (/^\*/.test(clause.trim())) return true;
  const named = clause.match(/\{([\s\S]*)\}/)?.[1] ?? "";
  return named
    .split(",")
    .map((s) => s.trim())
    .some((s) => /^PrismaClient\b/.test(s));
}

/** Pure scanner: the violations in one file's contents (empty when the file is clean or exempt). */
export function findDirectDbAccess(file: string, content: string): string[] {
  const violations: string[] = [];
  // Prisma internals that unwrap a scoped client to the base client; refused everywhere, exempt folders included.
  for (const m of content.matchAll(PRISMA_INTERNALS)) violations.push(`${file}: reaches Prisma internal ${m[0]}`);
  if (!file.startsWith(FRAMEWORK_DIR)) {
    for (const site of importSites(content)) {
      const target = resolveSpecifier(file, site.spec);
      if (target !== null && FRAMEWORK_ONLY.includes(target)) violations.push(`${file}: imports framework internal "${site.spec}"`);
    }
  }
  if (isExempt(file)) return violations;
  for (const site of importSites(content)) {
    const target = resolveSpecifier(file, site.spec);
    if (target === null) continue;
    if (target === BASE_DB) {
      violations.push(`${file}: imports the base db ("${site.spec}")`);
    } else if ((GENERATED_CLIENT.includes(target) || target === "@prisma/client") && !site.typeOnly) {
      if (importsPrismaClientValue(site.clause)) violations.push(`${file}: imports PrismaClient ("${site.spec}")`);
    }
  }
  if (/\bnew\s+PrismaClient\b/.test(content)) violations.push(`${file}: instantiates PrismaClient`);
  return violations;
}

function listSourceFiles(dir: string): string[] {
  const abs = path.join(ROOT, dir);
  let entries;
  try {
    entries = readdirSync(abs, { withFileTypes: true, recursive: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && /\.(ts|tsx)$/.test(e.name))
    .map((e) => path.relative(ROOT, path.join(e.parentPath, e.name)).split(path.sep).join("/"));
}

describe("enforcement", () => {
  it("feature folders never import the base db", () => {
    const files = SCANNED_DIRS.flatMap(listSourceFiles);
    // The scan must actually see files (guards a broken path or glob).
    expect(files).toContain("src/server/db.ts");
    expect(files).toContain("src/server/domain/permissions.ts");
    const violations = files.flatMap((f) => findDirectDbAccess(f, readFileSync(path.join(ROOT, f), "utf8")));
    expect(violations).toEqual([]);
  });

  it("the scanner detects every way of reaching the base client", () => {
    const file = "src/server/features/sales/action.ts";
    const bad = [
      `import { db } from "@/server/db";`,
      `import { db } from '@/server/db.ts';`,
      `import { db } from "../../db";`,
      `import * as base from "../../db/index";`,
      `export { db } from "@/server/db";`,
      `const { db } = await import("@/server/db");`,
      `const { db } = require("../../db");`,
      `import "@/server/db";`,
      `import {\n  Prisma,\n  PrismaClient,\n} from "@/generated/prisma/client";`,
      `import { PrismaClient as PC } from "../../../generated/prisma/client";`,
      `import { PrismaClient } from "@prisma/client";`,
      `const c = new PrismaClient({ adapter });`,
      `const base = scopedDb(actor)._appliedParent;`,
      `const raw = (tx as any)._originalClient.rtLocation;`,
      `await client._request({ action: "findMany" });`,
    ];
    for (const sample of bad) expect(findDirectDbAccess(file, sample), sample).not.toEqual([]);
    expect(findDirectDbAccess("src/app/page.tsx", `import { db } from "../server/db";`)).not.toEqual([]);

    const good = [
      `import type { PrismaClient } from "@/generated/prisma/client";`,
      `import { type PrismaClient, Prisma } from "@/generated/prisma/client";`,
      `import type { RtRole } from "@/generated/prisma/client";`,
      `import { scopedDb } from "@/server/framework/scoped-db";`,
      `import { dbx } from "@/server/dbx";`,
      `import { db } from "./db";`, // resolves to src/server/features/sales/db, not the base client
      `const x = obj._requestId;`,
    ];
    for (const sample of good) expect(findDirectDbAccess(file, sample), sample).toEqual([]);
  });

  it("platform-tx and transaction are importable from the framework folder only", () => {
    const bad = [
      `import { currentPlatformTx } from "@/server/framework/platform-tx";`,
      `import { currentPlatformTx } from "@/server/framework/platform-tx.ts";`,
      `import type { AuditDraft } from "@/server/framework/transaction";`,
      `const m = await import("@/server/framework/transaction");`,
    ];
    for (const f of ["src/server/intake/quota.ts", "src/server/admin/x.ts", "src/server/auth/y.ts", "src/app/page.tsx"]) {
      for (const sample of bad) expect(findDirectDbAccess(f, sample), `${f}: ${sample}`).not.toEqual([]);
    }
    expect(findDirectDbAccess("src/server/intake/quota.ts", `import { currentPlatformTx } from "../framework/platform-tx";`)).not.toEqual([]);
    for (const sample of bad) expect(findDirectDbAccess("src/server/framework/action.ts", sample), sample).toEqual([]);
    expect(findDirectDbAccess("src/server/intake/quota.ts", `import { planAiMonthly } from "@/server/framework/business-info";`)).toEqual([]);
  });

  it("the allowed folders are exempt and nothing else is", () => {
    const sample = `import { db } from "@/server/db";`;
    for (const f of ["src/server/db.ts", "src/server/framework/actor.ts", "src/server/auth/auth.ts", "src/server/admin/x.ts"]) {
      expect(findDirectDbAccess(f, sample)).toEqual([]);
    }
    expect(findDirectDbAccess("src/server/framework/x.ts", `const p = s._appliedParent;`)).toHaveLength(1);
    for (const f of ["src/server/domain/money.ts", "src/server/frameworkx/a.ts", "src/app/api/route.ts", "src/server/db-helpers.ts"]) {
      expect(findDirectDbAccess(f, sample)).toHaveLength(1);
    }
  });
});
