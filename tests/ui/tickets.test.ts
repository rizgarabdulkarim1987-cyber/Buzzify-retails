import { describe, expect, it } from "vitest";
import { addItem, parseHeld, type HeldCart, type SellItemDto } from "@/app/retail/sell/_lib/cart";
import { MAX_TICKETS, closeTicket, latestTicket, openTicket, orderTickets, saveTicket, ticketLines, ticketTotals } from "@/app/retail/sell/_lib/tickets";
import { ar } from "@/messages/ar";
import { ckb } from "@/messages/ckb";
import { en } from "@/messages/en";

const item = (id: string, price = "1500"): SellItemDto => ({
  variantId: id, unitId: id, nameAr: "سكر", nameCkb: null, nameEn: "Sugar", unitName: "pc", quantityScale: 0, factor: 1,
  soldByWeight: false, priceMinor: price, currency: "IQD", onHand: null, matchedBarcode: null, categoryId: null,
});
const at = (s: number) => new Date(Date.UTC(2026, 10, 5, 8, 0, s));
const first = () => openTicket([], "t1", at(0))!.store;

describe("parallel tickets", () => {
  it("opens numbered blank tickets with the smallest free number", () => {
    let store: HeldCart[] = first();
    store = openTicket(store, "t2", at(1))!.store;
    store = openTicket(store, "t3", at(2))!.store;
    expect(orderTickets(store).map((t) => [t.id, t.no])).toEqual([["t1", 1], ["t2", 2], ["t3", 3]]);
    store = closeTicket(store, "t2");
    expect(openTicket(store, "t4", at(3))!.ticket.no).toBe(2);
  });

  it("parking keeps each ticket's own lines; switching loses nothing", () => {
    let store: readonly HeldCart[] = first();
    store = saveTicket(store, "t1", addItem([], item("a")), at(1));
    store = openTicket(store, "t2", at(2))!.store;
    store = saveTicket(store, "t2", addItem(addItem([], item("b", "2000")), item("c", "500")), at(3));
    const t1 = store.find((t) => t.id === "t1")!;
    const t2 = store.find((t) => t.id === "t2")!;
    expect(ticketTotals(t1)).toEqual({ count: 1, total: 1500n });
    expect(ticketTotals(t2)).toEqual({ count: 2, total: 2500n });
    expect(ticketLines(t1)[0]!.variantId).toBe("a");
  });

  it("saving the same lines changes nothing (no write, no new time)", () => {
    const lines = addItem([], item("a"));
    const store = saveTicket(first(), "t1", lines, at(1));
    expect(saveTicket(store, "t1", lines, at(9))).toBe(store);
    expect(saveTicket(store, "missing", lines, at(9))).toBe(store);
  });

  it("closing after a payment brings up the most recently used other ticket, or none", () => {
    let store: readonly HeldCart[] = first();
    store = saveTicket(store, "t1", addItem([], item("a")), at(1));
    store = openTicket(store, "t2", at(2))!.store;
    store = saveTicket(store, "t2", addItem([], item("b")), at(3));
    store = openTicket(store, "t3", at(4))!.store;
    store = saveTicket(store, "t3", addItem([], item("c")), at(5));
    store = saveTicket(store, "t1", addItem(addItem([], item("a")), item("d")), at(6));
    const rest = closeTicket(store, "t3");
    expect(rest.map((t) => t.id).sort()).toEqual(["t1", "t2"]);
    expect(latestTicket(rest)?.id).toBe("t1");
    expect(latestTicket(closeTicket(rest, "t1"), undefined)?.id).toBe("t2");
    expect(latestTicket(closeTicket(closeTicket(rest, "t1"), "t2"))).toBeNull();
  });

  it("allows at most MAX_TICKETS open sales", () => {
    expect(MAX_TICKETS).toBe(8);
    let store: HeldCart[] = first();
    for (let i = 2; i <= MAX_TICKETS; i++) store = openTicket(store, `t${i}`, at(i))!.store;
    expect(store).toHaveLength(8);
    expect(openTicket(store, "t9", at(9))).toBeNull();
    expect(openTicket(closeTicket(store, "t5"), "t9", at(9))?.ticket.no).toBe(5);
  });

  it("survives a reload: the stored text parses back and the last-used ticket is the one shown", () => {
    let store: readonly HeldCart[] = first();
    store = saveTicket(store, "t1", addItem([], item("a")), at(1));
    store = openTicket(store, "t2", at(2))!.store;
    store = saveTicket(store, "t2", addItem([], item("b")), at(3));
    const back = parseHeld(JSON.stringify(store));
    expect(back).toEqual(store);
    expect(latestTicket(back)?.id).toBe("t2");
    expect(orderTickets(back).map((t) => t.no)).toEqual([1, 2]);
  });

  it("carts held before numbering get numbers, oldest first, and keep their lines", () => {
    const legacy: HeldCart[] = [
      { id: "new", at: at(5).toISOString(), lines: ticketLinesOf("n") },
      { id: "old", at: at(1).toISOString(), lines: ticketLinesOf("o") },
    ];
    expect(orderTickets(legacy).map((t) => [t.id, t.no])).toEqual([["old", 1], ["new", 2]]);
    expect(parseHeld(JSON.stringify([{ id: "x", at: "y", no: 0, lines: [] }]))).toEqual([]);
  });

  it("the ar, ckb and en messages carry the new keys and no Hold key", () => {
    for (const t of [ar, ckb, en]) {
      for (const k of ["newSale", "saleNo", "saleOf", "saleEmpty", "openSales", "ticketsLimit", "openCategory", "departments"] as const) expect(t.till[k].length).toBeGreaterThan(1);
      expect(t.till.saleNo).toContain("{n}");
      expect(t.till.saleOf).toContain("{total}");
      expect(t.till.ticketsLimit).toContain("{max}");
      expect("fnHold" in t.till).toBe(false);
    }
  });
});

function ticketLinesOf(id: string): HeldCart["lines"] {
  return addItem([], item(id)).map((l) => ({ ...l, priceMinor: l.priceMinor.toString() }));
}

describe("switching", () => {
  it("touching a ticket makes it the one a reload brings back, without changing its lines", async () => {
    const { touchTicket } = await import("@/app/retail/sell/_lib/tickets");
    let store: readonly HeldCart[] = openTicket([], "t1", at(0))!.store;
    store = saveTicket(store, "t1", addItem([], item("a")), at(1));
    store = openTicket(store, "t2", at(2))!.store;
    store = saveTicket(store, "t2", addItem([], item("b")), at(3));
    expect(latestTicket(store)?.id).toBe("t2");
    const back = touchTicket(store, "t1", at(9));
    expect(latestTicket(back)?.id).toBe("t1");
    expect(back.find((t) => t.id === "t1")!.lines).toEqual(store.find((t) => t.id === "t1")!.lines);
  });
});
