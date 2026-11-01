import type { Locale } from "@/messages";
import { pickName } from "../../../_lib/format";
import type { CategoryDto } from "./types";

export type CategoryOption = { id: string; label: string; depth: number };

const SEP = " › ";

/**
 * The category tree as a flat, depth-first list ("Food", "Food › Grains", ...), roots and siblings
 * by name in the interface language, so a select or a type-ahead shows where each one sits.
 * A cycle or an orphan in the data cannot loop: each row is listed once.
 */
export function categoryOptions(locale: Locale, categories: readonly CategoryDto[]): CategoryOption[] {
  const byParent = new Map<string | null, CategoryDto[]>();
  const known = new Set(categories.map((c) => c.id));
  for (const c of categories) {
    const parent = c.parentId !== null && known.has(c.parentId) ? c.parentId : null;
    byParent.set(parent, [...(byParent.get(parent) ?? []), c]);
  }
  const name = (c: CategoryDto) => pickName(locale, c);
  const out: CategoryOption[] = [];
  const seen = new Set<string>();
  const walk = (parent: string | null, trail: string[]) => {
    const kids = [...(byParent.get(parent) ?? [])].sort((a, b) => name(a).localeCompare(name(b), locale));
    for (const c of kids) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      const path = [...trail, name(c)];
      out.push({ id: c.id, label: path.join(SEP), depth: trail.length });
      walk(c.id, path);
    }
  };
  walk(null, []);
  return out;
}
