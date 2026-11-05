# One-screen cashier till: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the touch till with the fixed, no-scroll, one-screen cashier till of the mockup: line table with pages, X and Undo, side column (shift total, selected product with batches and expiry, receipts, calculator), hold and switch, returns; expenses leave the cashier.

**Architecture:** Three slices, each shippable and each its own PR: (1) the screen, on existing data plus two read additions, no migration; (2) returns (one additive migration); (3) manager PIN for discounts and cashier quick-add. The screen stays a client component over the existing `SellScreen` state (`tickets.ts` already holds parallel sales per device); new pure helpers get unit tests first.

**Tech Stack:** Next.js (read `node_modules/next/dist/docs/` first), React, Prisma 7 + Postgres, zod, `defineAction`, vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-05-one-screen-till-design.md` (mockup: `docs/superpowers/mockups/till-one-screen.html`).

## Global Constraints

- Money is BigInt minor units; nothing on the till carries cost (`_lib/dto.ts` never adds `costMinor`).
- No popups, no scroll bars on the till, 44px touch targets, RTL logical CSS only (no fixed left/right), dark and light tokens from `sell.css`.
- Words come from the message catalogs in ar, ckb, en (the existing words guard in `tests/ui/sell-ui.test.ts` must stay green); no hard-coded copy.
- Migrations are additive and hand-written CHECKs where the schema needs them; the CI drift check must pass. They are NOT applied automatically on production: every PR with a migration says so at the top of its description.
- E2E: type on the till only through `typeDigitsWhenReady`; one worker; leave no open shift on `TERMINAL_A`.
- Commit trailer: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. No push or merge without the owner's word.

## Review Focus

1. 40+ lines at 375x667 and 1280x720: no scrollbar on the document or table; selected line stays on the visible page (Task 5).
2. Deleting the last line on a page, the only line, or the selected line: selection and page stay valid; Undo puts it back in the same place (Task 5).
3. Hold A, sell B, back to A: A's lines, selection and page restored; reload keeps all open sales (Task 6).
4. A return larger than what was sold, or a second return of the same receipt: refused, nothing written (Task 8).
5. A product with no batches, or only expired batches: expiry shows "none" and stock still correct; selling picks earliest expiry first (Task 3).

## File Structure

- Create `src/app/retail/sell/_lib/pager.ts`: `pageSlots`, `pageOf`, `pageWindow` (pure).
- Create `src/app/retail/sell/_lib/calc.ts`: calculator reducer (pure).
- Create `src/app/retail/sell/line-table.tsx`: the wide table, pager, X, Undo bar, inline results.
- Create `src/app/retail/sell/side-column.tsx`: shift card, selected-product card, receipts card, calculator.
- Modify `src/app/retail/sell/sell-screen.tsx` (layout, wiring), `sell.css` (grid, no-scroll), `_lib/views.tsx`, `_lib/dto.ts`, `_lib/cart.ts` (types).
- Modify `src/server/sales/catalog.ts` (expiry and batches), create `src/server/sales/recent.ts` (receipts list).
- Move expenses: `src/app/retail/sell/expense-panel.tsx` out of the till into a manager screen under the shell; permission change in `src/server/domain/permissions.ts` plus a migration for seeded role permissions only if permissions are stored (check; otherwise code only).
- Slice 2: `prisma/schema.prisma`, new migration, `src/server/sales/returns.ts`, `permissions.ts`.
- Slice 3: `prisma/schema.prisma` (manager PIN hash), `src/server/sales/discount.ts`, quick-add in `catalog.ts`.

---

## SLICE 1: the screen

### Task 1: Pager helpers

**Files:** Create `src/app/retail/sell/_lib/pager.ts`; Test `tests/ui/till-pager.test.ts`.

**Interfaces:** Produces `pageSlots(heightPx: number, rowPx: number): number` (at least 1), `pageOf(selected: number, slots: number): number`, `pageWindow<T>(items: readonly T[], page: number, slots: number): T[]`.

- [ ] **Step 1: Write the failing test** `till-pager.test.ts`: `pageSlots(368, 46) === 8`; `pageSlots(10, 46) === 1`; `pageOf(8, 8) === 1`; `pageOf(7, 8) === 0`; `pageWindow` of 20 items, page 2, slots 8 returns items 16 to 19; page beyond the end clamps to the last page.
- [ ] **Step 2:** Run `npx.cmd vitest run tests/ui/till-pager.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3:** Implement the three functions in `pager.ts`.
- [ ] **Step 4:** Run the test. Expected: PASS.
- [ ] **Step 5:** Commit `feat(till): pager helpers`.

### Task 2: Calculator reducer

**Files:** Create `_lib/calc.ts`; Test `tests/ui/till-calc.test.ts`.

**Interfaces:** Produces `type CalcState = { acc: number | null; op: "+" | "-" | "*" | "/" | null; cur: string; fresh: boolean }`, `initialCalc`, `calcPress(s: CalcState, key: string): CalcState`, `calcDisplay(s: CalcState): string` (ASCII; the view formats with the locale).

- [ ] **Step 1: Write the failing test:** `7 + 5 =` shows `12`; `10 / 0 =` shows `0` and does not throw; `200 + 10 %` adds 10% of 200 (`220`); `5 * 3 %` is `0.15`; `C` clears; backspace on a single digit gives `0`; a second `.` is ignored; chained `2 + 3 + 4 =` gives `9`; a result is rounded to 6 decimals.
- [ ] **Step 2:** Run it. Expected: FAIL.
- [ ] **Step 3:** Implement. Keep the percent rule of the mockup (after `+`/`-`: percent of the accumulator; after `*`/`/` or alone: divide by 100).
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(till): calculator reducer`.

### Task 3: Expiry and batches on the till item

**Files:** Modify `src/server/sales/catalog.ts` (`SellItem`, `listSellItems`), `src/app/retail/sell/_lib/dto.ts`, `_lib/cart.ts` (`SellItemDto`); Test `tests/sales/sell-items-expiry.test.ts`.

**Interfaces:** `SellItem` gains `batches: { expiryDate: string | null; qty: bigint }[]` (ISO date, stock above zero only, earliest expiry first, null expiry last) and `earliestExpiry: string | null`. `SellItemDto` gets the same with `qty` as a string. Only filled when `locationId` is given (same rule as `onHand`).

- [ ] **Step 1: Write the failing test:** an item with two batches (expiring 2026-11-20 qty 12, 2026-12-28 qty 36) returns both in that order and `earliestExpiry` 2026-11-20; a batch with zero stock is left out; an item with no batches returns `[]` and `null`; an expired batch is still listed (the till colours it, the sale already refuses it); no cost field appears in the dto.
- [ ] **Step 2:** Run `npx.cmd vitest run tests/sales/sell-items-expiry.test.ts`. Expected: FAIL.
- [ ] **Step 3:** In `listSellItems`, read `rtStockBalance` rows of the chosen variants at the location with their batch's `expiryDate` (one query, not one per item), group in memory.
- [ ] **Step 4:** Run. Expected: PASS; run `tests/sales` whole to confirm nothing else moved.
- [ ] **Step 5:** Commit `feat(sales): batches and earliest expiry on sell items`.

### Task 4: Recent receipts of the shift

**Files:** Create `src/server/sales/recent.ts`; Modify `_lib/dto.ts`; Test `tests/sales/recent-sales.test.ts`.

**Interfaces:** Produces action `listRecentSales` (name `sale.recent`, permission `sale.create`, input `{ limit: number (1..20, default 10) }`, `writes: false`) returning `SaleView[]` of the actor's own open shift, newest first, with lines (no cost). Reuses `readSale`.

- [ ] **Step 1: Write the failing test:** after three sales, the list has three, newest first, each with its lines; another cashier's sales and a closed shift's sales are not returned; `limit: 2` returns two.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement with two queries (ids of the shift's sales, then `readSale` per id in one pass if it has a batch form, else a loop bounded by the limit).
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(sales): recent sales of the open shift`.

### Task 5: Line table with pages, X and Undo

**Files:** Create `src/app/retail/sell/line-table.tsx`; Modify `sell.css`, `_lib/views.tsx` as needed; Test `tests/ui/till-line-table.test.ts`.

**Interfaces:** Consumes Task 1 and Task 3. Produces `<LineTable lines items selected onSelect onQty onRemove onDiscount results onAddResult locale t />` where `lines: CartLine[]`, rows are 46px, the page follows `selected`, pager arrows show only when pages > 1, and the header cell shows `page/pages`. `onRemove(i)` removes and the parent keeps `{line, at}` for Undo (6 seconds, then dropped).

- [ ] **Step 1: Write the failing UI test** (render to string like the other `tests/ui` files): with 3 lines no pager; with 40 lines and 8 slots the header shows `1/5` in the locale's digits and a next arrow; each row has an X button with an accessible name from the catalog; stock chip classes for ok, low (10 or fewer) and out; expiry chip is red at 30 days or fewer; no `overflow:auto` or `overflow-y:scroll` in the new CSS block (string check on `sell.css`).
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement the component and CSS per the mockup (grid columns `30px 1fr 64px 100px 112px 66px 64px 84px 46px`; `overflow: hidden` on the rows area; slots measured with a `ResizeObserver` on the rows element and `pageSlots`).
- [ ] **Step 4:** Run the test, then `npx.cmd tsc --noEmit` and `npx.cmd eslint src tests`. Expected: clean.
- [ ] **Step 5:** Commit `feat(till): wide line table with pages, X and undo`.

### Task 6: Side column, layout, hold and switch, remove expenses from the till

**Files:** Create `src/app/retail/sell/side-column.tsx`; Modify `sell-screen.tsx`, `sell.css`, `till-nav.tsx`, `src/app/retail/sell/page.tsx` (loads recent sales and drops expense data), `src/server/domain/permissions.ts`; Move `expense-panel.tsx` behind a manager-only route (path chosen by the builder under the existing shell, linked from its nav); Tests `tests/ui/sell-ui.test.ts` (update), `tests/schema/expenses.test.ts` (permission matrix update).

**Interfaces:** Consumes Tasks 2, 4, 5. Layout: grid columns `296px 1fr 236px` (calculator at the inline-start, table in the middle, shift, selected product and receipts at the inline-end), rows `auto auto 1fr`; phone (container under 760px): two panes, "Sell" and "Shift, receipts and calculator", bottom bar to switch. Open sales are tabs in the top bar (max 4 visible; the existing `MAX_TICKETS` stays the store limit, extra ones are reached from a "+N" tab); switching saves the current ticket through `saveTicket`.

- [ ] **Step 1: Write the failing tests:** the till for a cashier has no `fn-expense` and no expense panel; `expense.create` is manager and owner only (update the matrix test); the shift card shows count and total from `ShiftDto`; the receipts card lists up to 4 with print; the calculator "to Paid" fills the pay field; switching tabs restores each ticket's lines.
- [ ] **Step 2:** Run `npx.cmd vitest run tests/ui tests/schema`. Expected: FAIL on the new assertions.
- [ ] **Step 3:** Implement. The close screen keeps its expected-cash line; the expense list stays on the manager screen and the close page for managers.
- [ ] **Step 4:** Run the same command and `tsc` and `eslint`. Expected: PASS and clean.
- [ ] **Step 5:** Commit `feat(till): one-screen layout, side column, expenses to the manager`.

### Task 7: E2E

**Files:** Create `tests/e2e/till-one-screen.spec.ts`; Modify `tests/e2e/sell-expenses.spec.ts` (the cashier no longer records expenses: keep the manager void test, move the cashier cases to a manager login, add "a cashier has no Expense key"), `tests/e2e/sell-usd.spec.ts` if selectors changed.

- [ ] **Step 1: Write the spec:** at 1280x720 and 375x667, add 40 lines by scanning and assert `document.documentElement.scrollHeight <= clientHeight` and the rows element has `scrollHeight <= clientHeight + 1`; X removes a line and Undo restores it in place; hold sale A, start B, return to A; pay a sale in cash and see the shift total change.
- [ ] **Step 2:** Run with the temporary untracked config (`next dev --webpack`, the Turbopack junction problem): `npx.cmd playwright test tests/e2e/till-one-screen.spec.ts tests/e2e/sell-expenses.spec.ts tests/e2e/sell-usd.spec.ts`. Expected: PASS. Delete the temporary config before committing.
- [ ] **Step 3:** Run the whole e2e suite once; leftovers (an open shift) must not cascade.
- [ ] **Step 4:** Commit `test(till): one-screen e2e`.
- [ ] **Step 5:** Verify on screen at 1366x768, 1280x720, 375x667, dark and light, Arabic and English; save screenshots under `docs/superpowers/reports/assets/` and write `docs/superpowers/reports/one-screen-till-report.md` (verified, not verified, rulings).

---

## SLICE 2: returns (own PR, contains a migration)

### Task 8: Return of a receipt on the server

**Files:** Modify `prisma/schema.prisma` (RtSale: `returnOfSaleId String?` with relation, `kind` enum `SALE | RETURN` default SALE), new migration `20261106000000_sale_returns` (additive, CHECK: `kind = 'RETURN'` iff `returnOfSaleId` is set or the sale is a free return flagged `freeReturn`), `src/server/domain/permissions.ts` (`sale.return`: cashier, manager, owner; `sale.return.free`: manager, owner), create `src/server/sales/returns.ts`; Tests `tests/schema/returns.test.ts`, `tests/sales/returns.test.ts`.

**Interfaces:** Produces action `createReturn` (`sale.return`, input `{ returnKey: string; ofSaleId: string; lines: { lineNo: number; quantity: string }[] }` or `{ returnKey; free: true; lines: { variantId; unitId; quantity }[] }` for `sale.return.free`), returning `SaleView` with negative totals. Stock returns to the batches the sale took (free: newest batch, flagged). Refund method follows the original payments (cash back as cash, card as card; free returns refund cash). Shift totals subtract returns; locks as in `createSale`.

- [ ] **Step 1: Write the failing tests** (Review Focus 4): return of 1 of 3 sold restores 1 to the right batch and refunds that line's value; return of more than sold is refused with `RETURN_EXCEEDS_SOLD` and nothing is written; a second return of the same receipt can only take the remainder; a cashier without `sale.return.free` is refused a free return; replaying `returnKey` returns the same return; shift summary subtracts the refund; the closed shift refuses a return; a return refunding cash more than the drawer holds is refused like an expense.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement, reusing `postMovements` with positive deltas and the sale-number counter; audit entry like `createSale`.
- [ ] **Step 4:** Run `npx.cmd vitest run tests/sales tests/schema`; run the drift check form from the previous slice (apply migrations to the dev database, `prisma migrate diff ... --exit-code`).
- [ ] **Step 5:** Commit `feat(sales): returns of receipts and free returns`.

### Task 9: Return UI

**Files:** Modify `sell-screen.tsx`, `side-column.tsx`, `line-table.tsx`, `sell.css`; Test `tests/ui/till-return.test.ts`, e2e in `tests/e2e/till-one-screen.spec.ts`.

- [ ] **Step 1: Write the failing tests:** the Return toggle turns field and total red and the pay button reads Refund; scanning in Return mode adds a negative line; the receipt's return button fills the sale with that receipt's lines negative and carries `ofSaleId`; mixed positive and negative lines in one sale are refused on the client with a clear line (a sale or a return, never both).
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement; the confirm button calls `createReturn`; the receipt for a return is labelled and prints with negative amounts.
- [ ] **Step 4:** Run unit and e2e. Expected: PASS.
- [ ] **Step 5:** Commit `feat(till): returns on the one-screen till`.

---

## SLICE 3: manager PIN discount and quick-add (own PR, contains a migration)

### Task 10: Manager PIN and capped cashier discount

**Files:** Modify `prisma/schema.prisma` (user-side `RtManagerPin { userId, hash, updatedAt }`), migration, create `src/server/sales/discount.ts`, `createSale` input gains per-line `discountMinor` and an optional `managerPin`; retail admin screen to set a PIN (owner); Tests `tests/sales/discount.test.ts`.

- [ ] **Step 1: Write the failing tests:** a cashier discount up to 5% of the line's gross is accepted; 5.01% without a PIN is refused `DISCOUNT_NEEDS_MANAGER`; with a correct manager PIN accepted and the audit names the manager; a wrong PIN is refused and is rate-limited (5 tries, then 5 minutes); the PIN is stored hashed and never returned.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement (hash with the project's existing password hashing, compare in constant time).
- [ ] **Step 4:** Run `tests/sales`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(sales): capped cashier discount with manager PIN`.

### Task 11: Quick-add and the discount column

**Files:** Modify `catalog.ts` (action `quickAddItem`, permission `sale.create`, creates an active product flagged `needsReview`, price in the default list), `line-table.tsx` (inline quick-add row for an unknown barcode, inline PIN field on over-limit discount); Tests `tests/sales/quick-add.test.ts`, UI and e2e additions.

- [ ] **Step 1: Write the failing tests:** an unknown 8+ digit barcode shows the inline quick-add row; saving creates the product with that barcode, flagged for manager review, sells at once; the same barcode twice returns the same product; a manager sees the review flag in the catalog list; over 5% discount shows the PIN field and refuses until it is right.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run unit and e2e. Expected: PASS.
- [ ] **Step 5:** Commit `feat(till): quick-add and discount PIN inline`.

---

## Self-review

- **Spec coverage:** table and pages (T1, T5), X and Undo (T5), hold and switch (T6; the store already exists), returns (T8, T9), shift total (existing `ShiftDto`, shown in T6), receipts (T4, T6), expiry and batches (T3, T5, T6), calculator (T2, T6), expenses to manager (T6), no-scroll acceptance (T7), discount PIN and quick-add (T10, T11), phone panes (T6).
- **Held sales in the browser** is the existing behaviour; no task adds a table (spec call 2).
- **Order:** Slice 1 stands alone and ships without a migration. Slice 2 needs Slice 1's UI. Slice 3 is independent of Slice 2.
- **Not decided here:** exact manager-screen route for expenses (builder), column order inside the shift card, Sorani copy.
