import { cartCount, cartTotal, type CartLine, type HeldCart } from "./cart";

/*
 * Parallel tickets: every open sale of this till is one entry of the device's held-carts store
 * (the active one included, so a page reload loses nothing). Pure functions over that list; the
 * screen keeps the active ticket's lines in state and saves them here after every change.
 */

/** Most sales that can be open at once on one till. */
export const MAX_TICKETS = 8;

export function ticketLines(t: HeldCart): CartLine[] {
  return t.lines.map((l) => ({ ...l, priceMinor: BigInt(l.priceMinor) }));
}

export function ticketTotals(t: HeldCart): { count: number; total: bigint } {
  const lines = ticketLines(t);
  return { count: cartCount(lines), total: cartTotal(lines) };
}

/** The open tickets in sale-number order; carts held before numbers existed get the next free numbers (oldest first). */
export function orderTickets(store: readonly HeldCart[]): (HeldCart & { no: number })[] {
  const used = new Set(store.flatMap((h) => (h.no ? [h.no] : [])));
  let next = 1;
  const free = () => {
    while (used.has(next)) next++;
    used.add(next);
    return next;
  };
  const numbered = [...store].reverse().map((h) => ({ ...h, no: h.no ?? free() }));
  return numbered.sort((a, b) => a.no - b.no);
}

/** The ticket worked on most recently: the one to show after a reload or when another closes. */
export function latestTicket(store: readonly HeldCart[], except?: string): HeldCart | null {
  let best: HeldCart | null = null;
  for (const h of store) if (h.id !== except && (best === null || h.at >= best.at)) best = h;
  return best;
}

/** Opens a blank ticket with the smallest free sale number; `null` at the limit. */
export function openTicket(store: readonly HeldCart[], id: string, at: Date): { store: HeldCart[]; ticket: HeldCart } | null {
  if (store.length >= MAX_TICKETS) return null;
  const used = new Set(orderTickets(store).map((h) => h.no));
  let no = 1;
  while (used.has(no)) no++;
  const ticket: HeldCart = { id, at: at.toISOString(), no, lines: [] };
  return { store: [...orderTickets(store), ticket], ticket };
}

/** Saves a ticket's lines; the same list comes back when nothing changed (so nothing is written). */
export function saveTicket(store: readonly HeldCart[], id: string, lines: readonly CartLine[], at: Date): readonly HeldCart[] {
  const t = store.find((h) => h.id === id);
  if (!t) return store;
  const packed = lines.map((l) => ({ ...l, priceMinor: l.priceMinor.toString() }));
  if (JSON.stringify(packed) === JSON.stringify(t.lines)) return store;
  return orderTickets(store).map((h) => (h.id === id ? { ...h, at: at.toISOString(), lines: packed } : h));
}

/** Closes a ticket (paid, voided, or an empty one left behind). */
export function closeTicket(store: readonly HeldCart[], id: string): HeldCart[] {
  return orderTickets(store.filter((h) => h.id !== id));
}

/** Marks a ticket as the one in use now (switching to it makes it the one a reload brings back). */
export function touchTicket(store: readonly HeldCart[], id: string, at: Date): HeldCart[] {
  return orderTickets(store).map((h) => (h.id === id ? { ...h, at: at.toISOString() } : h));
}
