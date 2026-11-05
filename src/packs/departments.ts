/*
 * The standard departments of a pack: a fixed starter tree kept as data, one folder per product
 * (src/packs/<product>/departments.ts). It is NOT written to any database by this file; a later
 * "Add the standard categories" action creates it per business, skipping a name that exists.
 * Kurdish (ckb) names are a first draft for a native speaker to review.
 */

export type DepartmentName = { ar: string; ckb: string; en: string };

export type StandardDepartment = DepartmentName & {
  /** The stable key the till picks the card's glyph and accent by. Unique across packs, except "other". */
  key: string;
  children?: readonly DepartmentName[];
};

export type DepartmentTree = readonly StandardDepartment[];
