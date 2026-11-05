/* The till's fixed pages: a long sale is shown a page at a time (arrows), never scrolled. Pure. */

/** How many whole rows fit in `heightPx`, at least one. */
export function pageSlots(heightPx: number, rowPx: number): number {
  return Math.max(1, Math.floor(heightPx / rowPx));
}

/** The page a row sits on. */
export function pageOf(index: number, slots: number): number {
  return Math.floor(Math.max(0, index) / Math.max(1, slots));
}

/** One page of items; a page past the end shows the last page. */
export function pageWindow<T>(items: readonly T[], page: number, slots: number): T[] {
  const s = Math.max(1, slots);
  const last = Math.max(0, Math.ceil(items.length / s) - 1);
  const p = Math.min(Math.max(0, page), last);
  return items.slice(p * s, p * s + s);
}
