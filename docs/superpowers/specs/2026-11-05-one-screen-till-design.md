# One-screen cashier till: design

Status: draft for the owner's approval. Nothing is built. Reference mockup: `docs/superpowers/mockups/till-one-screen.html` (interactive; open it in a browser).

## Intent

The cashier sells and never leaves the sale screen. Everything that matters to selling is on that one screen: the lines, the remaining stock and expiry of the item, the receipts, the shift total, a calculator, holding a sale and switching to another, and returning items. The screen is fixed: it never scrolls, however many lines are added, and it has no popups and no extra-action buttons that open panels.

## Goals

1. A wide line table (pharmacy-style) replaces the product cards. Columns: number, product (with the other pack size under the name), remaining stock, expiry, quantity with - and +, price, line discount, line total, X.
2. No scroll at any size. Long receipts use fixed pages with arrows; the page follows the selected line.
3. X on every line deletes it at once; an inline Undo bar (6 seconds) replaces a confirmation.
4. Hold and switch: up to 4 open sales as tabs; switching parks the current sale unchanged; "new sale" opens an empty one.
5. Returns, two ways: a Return toggle beside the scan field (scans come in as negative quantity), and a Return button on each recent receipt (its items come in as negative lines). The total turns red, reads "Return total", and the pay button reads "Refund".
6. Side column: shift total (sales count, total, cash/card/USD split), selected product (remaining stock, batches with expiry dates and days left), recent receipts (with print and return), a calculator that can send its result to "Paid".
7. Unknown barcode: a quick-add row inside the table (name and price), marked "new, manager reviews".
8. Phone: two fixed panes, "Sell" and "Shift, receipts and calculator", switched from a bottom bar. 44px targets, RTL, dark and light.

## Non-goals and anti-goals

- No expenses, wages, drawer-expected cash or any money-out on the cashier screen. (Anti-goal: the cashier screen must not show an Expense key or panel.)
- No popups, modals or drawers; no scroll bars on the till.
- No cost or profit data on the till (cost never leaves the server).
- No customer credit, suppliers, purchases in this slice.

## Constraints

- Next.js in this repo has breaking changes: read `node_modules/next/dist/docs/` before writing UI.
- Money is BigInt minor units (dinar base; USD through `fx.ts`). Cost stays server-side (`dto.ts`).
- Write actions go through `defineAction` (locks, idempotency, audit).
- Arabic first, Sorani and English supported; no per-letter text splitting; no fixed left/right CSS.
- CI e2e types on the till: use `typeDigitsWhenReady`; do not type before hydration.
- Migrations are additive, and are applied on production by hand (backup first). The PR must say which migrations it contains.

## Decisions (the owner's, as given)

- The cashier is about selling only; expenses leave the cashier screen.
- Remaining stock, receipts, shift total and expiry are on the screen.
- Fixed screen, no scroll, no popups, calculator always present, X per line, pharmacy-style table.
- Hold-and-switch sale; return of items.

## My calls (change any of them)

1. **Expenses move to the manager.** The cashier loses `expense.create` and the Expense function key. Existing expense code and data stay; the Expense panel moves to a manager-only screen (reached from the shell, not the till). The close screen keeps its expected-cash line.
2. **Held sales live in the browser** (per terminal), not the database. A held sale survives a tab switch and a reload (localStorage per shift), not a device change. If the owner needs it across devices, add an `RtHeldSale` table later.
3. **Returns are a sale with negative lines.** A return needs permission `sale.return` (cashier, manager, owner). A return of a specific past receipt is limited to that receipt's quantities; a free return (no receipt) is limited to manager and owner. Refund method follows the original receipt; a free return refunds cash. Stock goes back to the batch the item came from (free return: the newest batch, flagged).
4. **Discount:** a cashier may discount a line up to 5% of its gross. Above that, the line asks for a manager PIN inline. This needs a per-manager PIN (new field, hashed, set by the owner). Until the PIN exists, the cashier is capped at 5% and the field refuses more.
5. **Expiry** shown is the earliest batch that still has stock; red when 30 days or fewer remain. Selling picks the earliest-expiring batch first (FEFO).
6. **Shift total** counts sales only (returns subtract), split by method; it never includes opening cash or expenses.
7. Page size = floor(table height / 46px), recomputed on resize.

## What the builder must add (data and server)

- Till item DTO gains `earliestExpiry` and the batch list (qty, expiry) for the selected product; still no cost.
- A read for the shift's sales summary and the last N receipts with their lines.
- `createSale` accepts negative quantities under the rules in call 3 and returns the refund amount; a new action or flag, locked and idempotent like the sale itself.
- Permission `sale.return`; manager PIN field (call 4).
- Quick-add product creation by the cashier is flagged for manager review.

## Left to the builder

Component split, exact column widths, the way the page size is measured, calculator internals, copy in Sorani, and the e2e layout. The mockup fixes behavior and arrangement, not code.

## Acceptance

- At 1366x768, 1280x720 and 375x667: with 40 lines, the page has no scrollbar and no element overflows (asserted in e2e by comparing scrollHeight and clientHeight on the document and the table).
- X deletes a line and Undo restores it in the same position.
- Holding sale A, selling B, and returning to A restores A's lines and selection.
- A return never exceeds the receipt's sold quantity, and stock goes back.
- A cashier sees no Expense key or panel; a manager can reach expenses from the shell.
- Existing sale, dollar and shift e2e specs stay green.

## Open items for the owner

1. Do you want free returns (no receipt) for the cashier at all? My call: manager and owner only.
2. Should held sales survive a device change? My call: no.
3. Manager PINs: the owner sets them in Studio or in the retail admin? My call: retail admin.
