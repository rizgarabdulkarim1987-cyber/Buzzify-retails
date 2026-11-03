# MARKET POS: first selling slice (R3) — report

Branch: `retail-pos-market` (cut from `origin/main`). Nothing pushed, merged, deployed or opened as a PR.
No remote or production database was touched: all work ran against the local embedded Postgres
(port 54329) on the databases `retails_test_pos` (tests), `retails_mig_pos` (migration diff) and
`retails_dev_pos` (browser check).

## What was built

### Backend (TDD, existing action / service / zod / RuleError patterns)

- **Schema + migration** `prisma/migrations/20261103100000_sales` (additive only, no destructive SQL):
  `RtShift`, `RtSale`, `RtSaleLine`, `RtPayment`, `RtSaleCounter`, enum value `SALE` on
  `RtStockDocumentKind`, new enums `RtShiftStatus`, `RtSaleStatus`, `RtPaymentMethod`. Hand-written
  partial unique index (one OPEN shift per person per business) and CHECK constraints (closed-shift
  fields, difference = counted − expected, sale totals / change / line amounts, payment amount > 0,
  tendered ≥ amount, card exact, counter ≥ 1). `prisma migrate diff` reports no drift.
- **Permissions**: `sale.create` (OWNER, MANAGER, CASHIER), `shift.manage` (OWNER, MANAGER).
- **Shifts** `src/server/sales/shifts.ts`: `openShift`, `closeShift` (expected vs counted, difference
  stored), `myOpenShift`, `shiftSummary`, `tillState` (business currency + open-shift summary).
- **Sales** `src/server/sales/sales.ts`: `createSale` / `getSale`. One transaction: shift lock →
  variant stock locks → dated price resolution (frozen on the line) → half-up line totals →
  `PRICE_CHANGED` guard → payment settlement (cash, card, mixed) → FEFO batch pick (expired batches
  refused, `STOCK_EXPIRED` vs `STOCK_NEGATIVE`) → SALE stock document posted through the existing
  ledger (never negative) → gap-free per-branch sale number → sale, lines, payments. The `saleKey`
  plus the framework idempotency key make a double tap / retry return the first sale.
- **Till reads** `src/server/sales/catalog.ts`: `listSellCategories`, `listSellItems` (category tree,
  text search, barcode scan picks the scanned unit), `currentUnitPrices` (cart refresh after PRICE_CHANGED).
- Pure domain `src/server/domain/sale.ts`: `settlePayments`, `pickFefo`.

### UI `src/app/retail/sell` (RTL-first, touch-first, project tokens only)

Screens:

1. **Open shift** (`/retail/sell` with no open shift): one big amount box (Arabic or Latin digits),
   "drawer is empty" button, "open shift and start selling".
2. **Sale screen** (`/retail/sell`): shift strip with "close shift" link; big search / scanner box
   (any printable key typed outside a field goes to it; Enter with a single barcode hit adds straight
   to the cart); category chips (horizontal scroll); product tiles (name, price, unit, "out" marker,
   disabled without a price); cart with big −/+ steppers, a weight box for weighed units, remove,
   big total and PAY; hold / resume carts. ≥ 900px: two columns with a sticky cart. Phone: a fixed
   bottom bar (cart count + total + PAY) and the cart as a full-screen sheet.
3. **Pay** (dialog): due / received / remaining or change; cash quick amounts (exact first, then
   round-ups and notes 5,000 / 10,000 / 25,000 / 50,000 / 100,000, all ≥ due, max 6), "other amount",
   "all by card" / "rest by card", clear payment, complete sale. Network failure keeps the attempt key
   so a retry cannot sell twice; PRICE_CHANGED refreshes prices and returns to the cart with a notice.
4. **Receipt**: sale number, lines, total, cash / card, cash received and change, Print (80 mm print
   CSS, only the receipt prints) and New Sale.
5. **Close shift** (`/retail/sell/close`): day summary (sales count, total, cash, card, opening cash,
   expected cash), counted-cash box with live difference (matches / over / short), optional note, close;
   then the closed result with the recorded difference and "open a new shift".

Navigation: cart icon "Sell" in the shell header (only with `sale.create` and a chosen branch) and a
"Sell" card first on `/retail/home`. Branch switching now refuses while the user has an open shift in
the branch being left (`canSwitchBranch` gets the real state; the message already existed).

All strings are in `src/messages` (`sell` section, ar / ckb / en). **The Sorani (ckb) strings are
machine-drafted** and need a native speaker's review. Names are never split per character; motion is
limited to short fades / sheet slide / press scale and is switched off under `prefers-reduced-motion`.

## Tests

- `tests/sales/sales.test.ts` (20 tests): open twice, wrong branch, close difference, close
  permissions, stock officer forbidden, cash sale with SALE document and ledger rebuild, double tap /
  retry, oversell with two concurrent cashiers, FEFO and expired batches, mixed payment, rounding
  (0.333 kg, Arabic digits), dated price frozen + PRICE_CHANGED, price missing + override permission,
  shift required + numbering, cross-business isolation, READ_ONLY business, trial / archived / wrong
  unit, till catalog, current prices + till state.
- `tests/domain/sale.test.ts`: pure payment settlement and FEFO.
- `tests/ui/sell-ui.test.ts` (15 tests): cart rules (merge, steps, weights with Arabic digits matching
  the server's `lineValueMinor`, reprice), quick amounts, pay state (change, mixed, card-over refusal),
  amount parsing, held-cart storage (round trip, cap, junk dropped), views rendered with
  `renderToStaticMarkup` (tile, cart line labels in ar / en, pay summary, receipt, shift summary,
  difference words), and ar / ckb / en key parity of `sell`.
- Updated: permissions matrix, scoped-db branch-scoped list, stock UI kinds list.

## Checks run

- `npm run typecheck`: clean. `npm run lint`: clean.
- `tests/sales` 20/20 and `tests/ui/sell-ui.test.ts` 15/15 pass.
- Full suite: 1099 / 1106 pass; the 7 failures (4 unrelated files) pass on an isolated rerun — see "Failures".
- Impeccable detector on `src/app/retail/sell`: no findings. `21st review`: not run, the `21st` CLI is
  not installed on this machine.

## Browser check (what was seen)

Dev server on `localhost:3107` against `retails_dev_pos`, seeded with the project's own e2e seed
(`tests/e2e/seed.ts`, its fixture test accounts) plus local-only categories, products and opening
stock (scratch script, not committed). Signed in as the e2e cashier, chose branch + terminal 1.

- Desktop: open-shift screen rendered; opened with ٥٠٠٠٠ typed in Arabic digits. Sale screen showed the
  categories, tiles with prices and an "out" marker on the unstocked item. Tapped sugar twice, white
  cheese, then typed a barcode with no field focused and pressed Enter: water went straight into the
  cart. Set the cheese weight to ٠٫٢٥ → 1,500. Total 4,250. Pay: 2,000 cash via "other amount" + "rest
  by card" 2,250 → receipt no. 1 with both payments.
- Phone (375×812): bottom bar with count, total and PAY; cart sheet opens / closes; pay dialog fits the
  screen; 5,000 note for a 1,250 sale → receipt no. 2 with change 3,750 shown large.
- Close shift (phone): summary 2 sales, 5,500 total, 3,250 cash, 2,250 card, expected 53,250; counted
  53,000 → "short 250"; closing showed the recorded difference.
- Home shows the Sell card first.

Fixed during the check: the close-shift page overflowed horizontally on a phone (grid min-content);
the opening-cash placeholder repeated the currency; the receipt listed "cash received" even when it
equalled the cash amount.

Not seen in the browser: English / Kurdish rendering, the held-carts flow, PRICE_CHANGED and network
retry paths (covered by unit tests only), actual printing to a receipt printer.

## Rulings

- Ruling: one shift per person per business (partial unique index), not per terminal; terminalId is optional — the simplest cashier model, works without terminals — multi-cashier shared drawers would need a schema change.
- Ruling: a sale is in the business default currency only, no dual-currency sale or exchange rate — spec open question أ is unresolved — USD tills need a follow-up (currency on sale + rate).
- Ruling: price override needs `discount.override` (owner, manager) and the UI exposes no override — keeps the cashier screen simple and safe — a shop wanting cashier discounts needs a UI and maybe a new permission.
- Ruling: held carts are client-side (localStorage per business + user, max 10, memory fallback) — no schema or server cost for the first slice — holds do not follow the user to another device and reserve no stock.
- Ruling: saleKey = the attempt's idempotency key; a known saleKey returns the existing sale (`replayed`) — double tap and network retry can never sell twice — a client that reuses a key for a different cart gets IDEMPOTENCY_MISMATCH.
- Ruling: the SALE stock document is created POSTED directly; a line split over batches gets several movements and a null stock-line batch — keeps the ledger as the single source — reports per batch must read movements, not stock lines.
- Ruling: card may not exceed the total and cash is refused when card already covers it (CASH_NOT_NEEDED) — change is only ever given from cash — a shop that gives cash-back on card would need a rule change.
- Ruling: line cost is stored on the sale line and never sent to the browser — margin reporting later without leaking cost to cashiers — none known.
- Ruling: sale numbers are per branch and gap-free (counter row locked in the sale transaction) — matches paper-receipt expectations — slight serialization per branch under very high load.
- Ruling: a shift sells from the branch's oldest sellable location (else oldest location) — no location picker on the till — a branch with several sellable stores needs a picker.
- Ruling: the till shows the user's open shift even if the header branch differs (the shift's location is used) — avoids stranding an open shift — the header may show a different branch than the one being sold from; the branch switch now refuses while a shift is open, so this only happens if access changes.
- Ruling: weighed items are added as 1 unit then the weight is typed in the line's box — one tap plus one entry, works without a scale — a connected scale or a weight prompt on tap would be faster.
- Ruling: quick amounts = exact, round-ups to 1,000 / 5,000 / 10,000 / 25,000 and the notes 5,000 … 100,000, all ≥ due, at most 6; notes add up — covers single-note and two-note payments — shops may want configurable notes.
- Ruling: impeccable ran without PRODUCT.md as an extension of the existing design system (I am a subagent and could not interview the owner) — follows the brief and tokens — the owner may want a different till look.
- Ruling: no 21st components were used (they need Tailwind / shadcn, which the project lacks) — keeps one design system — none.
- Ruling: commit trailer uses "Claude Sonnet 5.5" as the brief specified (the harness suggested a different model name) — the brief is the user's instruction — trailer text may be inaccurate about the model.

## Failures and honest notes

- The machine is slow and shared: several DB tests hit the 10 s `beforeEach` (truncate) hook timeout
  at random; the same files pass with `--hookTimeout=60000`. Before this work the full suite already
  had 5 failures in 3 files (login-throttle prune, a stock schema test timeout, others) while running
  next to a client regeneration.
- **Final full suite** (`retails_test_pos`, one run, ~11 min): 1099 passed, 7 failed in 4 files, none
  of them sales or sell files: `tests/admin/support.test.ts` (2), `tests/auth/login-throttle.test.ts`
  (2), `tests/core/provision.test.ts` (1), `tests/intake/barcode.test.ts` (2). Six were 10 s hook
  timeouts; the two login-throttle ones failed fast. Re-running exactly those 4 files alone with
  `--hookTimeout=60000 --testTimeout=60000`: **86/86 pass**. I read them as load / timing flakiness of
  this machine, not regressions, but I did not prove the login-throttle cause beyond the clean rerun.
- `next dev` printed "Generated AGENTS.md"; `git status` showed no change to AGENTS.md, and it was
  not edited.
- No Playwright e2e spec was added for the till.

## Not done

- No USD or dual-currency sale; no voids, returns or refunds; no discounts / price override UI.
- Held carts are not stored on the server and do not reserve stock.
- No terminal-level cash drawers; no manager screen to close someone else's shift (the service allows it).
- No e2e (Playwright) test; no receipt-printer integration beyond the browser print dialog.
- Sorani strings need a native review.
