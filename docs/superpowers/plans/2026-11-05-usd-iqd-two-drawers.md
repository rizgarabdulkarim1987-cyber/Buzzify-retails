# USD and IQD cash at the till, two-drawer shift close: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A cashier can take part or all of a sale in US dollars; the shift keeps a dinar drawer and a dollar drawer and closes both.

**Architecture:** Additive migration on `RtShift` and `RtPayment` (design: the spec below). Amounts that already exist stay in dinars; dollars live in three new nullable payment fields. The server recomputes the dinar value from dollars and the shift rate. The pay panel gets a "Cash USD" method; the open and close shift forms get the dollar fields.

**Tech Stack:** Next.js (read `node_modules/next/dist/docs/` before UI work, see AGENTS.md), Prisma 7 + Postgres, zod, vitest, Playwright. Messages in `src/messages/{ar,ckb,en}.ts`, own-words guard in `tests/messages`.

**Spec:** `docs/superpowers/specs/2026-11-05-retail-usd-iqd-payment-design.md` (approved 2026-11-05; the four defaults stand).

## Global Constraints

- Prices and totals stay in dinars. `amountMinor` / `tenderedMinor` stay dinars. Change is always dinars.
- Rate = IQD per 1 USD x 10^6 (`rateMicro`, BigInt). Dinar credited = USD cents x rate, rounded down to a whole dinar (formula in Task 1).
- USD is hidden entirely when `USD` is not in `RtBusiness.enabledCurrencies` or the open shift has no `usdRateMicro`: the till looks exactly as today.
- Migration is additive: nullable or defaulted columns; existing rows stay valid; hand-written CHECKs from the spec.
- Sale posting stays idempotent (`saleKey`). Locks and order in `sales.ts` header do not change.
- All new words in ar, ckb, en; the own-words guard (`tests/messages`) must pass. No push, no merge, no deploy.
- RTL, 375px, dark and light themes must hold. 44px hit targets (existing `--till-hit`).
- Commit trailer: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Review Focus

- USD handed over exactly equals the due amount in dollars rounded: no change, no off-by-one dinar (rounding down must never leave a sale 1 IQD short; see Task 1 rule).
- A rate of 0, negative, or absurd (above 10,000 IQD per USD or below 100) at open or edit: refused.
- Retry of a USD sale with the same `saleKey` returns the posted sale and writes nothing (no second USD row).
- A client that sends a wrong dinar value for the dollars: refused (rate mismatch), nothing written.
- Closing a shift with only dinars (no USD ever used, rate unset): behaves exactly as before; `expectedUsdMinor` stays null.
- 15-line ticket and mixed USD + IQD + card on one sale at 375px, Arabic.

## File Structure

- Create `prisma/migrations/20261105100000_usd_drawer/migration.sql`; modify `prisma/schema.prisma` (RtShift, RtPayment).
- Create `src/server/domain/fx.ts` (pure money conversion, no db). Test `tests/sales/fx.test.ts`.
- Modify `src/server/domain/sale.ts` (`settlePayments`), `src/server/sales/sales.ts` (input, post, SaleView), `src/server/sales/shifts.ts` (open, close, summary, a manager-only `setShiftRate`).
- Modify `src/app/retail/sell/{actions.ts,shift-forms.tsx,sell-screen.tsx,_lib/*}` (pay panel, shift forms, receipt).
- Modify `src/messages/{ar,ckb,en}.ts`.
- Tests: `tests/sales/sales.test.ts` (extend), `tests/sales/shifts-usd.test.ts` (new), `tests/ui/sell-ui.test.ts` (extend), one e2e in `tests/e2e/`.

---

### Task 1: Money conversion (pure)

**Files:** Create `src/server/domain/fx.ts`; Test `tests/sales/fx.test.ts`

**Interfaces:**
- Produces:
  - `usdToDinar(usdCents: bigint, rateMicro: bigint): bigint` = floor(usdCents x rateMicro / 10^8) (cents x micro-rate, 10^6 for micro, 10^2 for cents).
  - `dinarToUsdCentsCeil(dinar: bigint, rateMicro: bigint): bigint` = the smallest cents whose `usdToDinar` is >= dinar (used for the "exact" chip so exact dollars always cover the due).
  - `validRateMicro(r: bigint): boolean` = 100 x 10^6 <= r <= 10_000 x 10^6.

- [ ] **Step 1: Write failing tests** in `tests/sales/fx.test.ts`: `usdToDinar(2000n, 1450_000000n) === 29000n`; `usdToDinar(1n, 1450_000000n) === 14n` (rounds down 14.5); `dinarToUsdCentsCeil(29250n, 1450_000000n)` gives cents `c` with `usdToDinar(c, r) >= 29250n` and `usdToDinar(c-1n, r) < 29250n`, for 200 random dinars and rates; `validRateMicro(0n)`, `-1n`, `99_999999n` false; `1450_000000n` true.
- [ ] **Step 2: Run** `npx.cmd vitest run tests/sales/fx.test.ts` — expect FAIL (module missing).
- [ ] **Step 3: Implement** the three functions in `src/server/domain/fx.ts`.
- [ ] **Step 4: Run** the same command — expect PASS.
- [ ] **Step 5: Commit** `feat(fx): dollar to dinar conversion with a rounding rule that never leaves a sale short`.

### Task 2: Migration and schema

**Files:** Create the migration; modify `prisma/schema.prisma`; Test `tests/schema/` (follow the existing CHECK tests there).

**Interfaces:**
- Produces columns: `RtShift.usdRateMicro BigInt?`, `openingUsdMinor BigInt @default(0)`, `countedUsdMinor BigInt?`, `expectedUsdMinor BigInt?`, `differenceUsdMinor BigInt?`; `RtPayment.tenderedCurrency Currency?`, `tenderedForeignMinor BigInt?`, `rateMicro BigInt?`.
- CHECKs: `RtPayment`: `(tenderedForeignMinor IS NULL) = (rateMicro IS NULL) AND (tenderedForeignMinor IS NULL) = (tenderedCurrency IS NULL)`; `rateMicro > 0` and `tenderedForeignMinor > 0` when set; method CARD never has them. `RtShift`: `usdRateMicro > 0` when set; `openingUsdMinor >= 0`; CLOSED USD fields: `countedUsdMinor`, `expectedUsdMinor`, `differenceUsdMinor` are all null or all set, and `differenceUsdMinor = countedUsdMinor - expectedUsdMinor`; an OPEN shift has none.

- [ ] **Step 1: Write failing schema tests** (insert a CARD payment with tendered USD fields: rejected; a USD payment with rate null: rejected; a valid USD CASH row: accepted; a closed shift with a wrong difference: rejected).
- [ ] **Step 2: Run** them — expect FAIL.
- [ ] **Step 3: Add the schema fields and hand-written migration SQL**; run `npx.cmd prisma generate` and the migration drift check used in CI (`prisma migrate diff --from-migrations prisma/migrations --to-schema prisma/schema.prisma --exit-code`, exit 0).
- [ ] **Step 4: Run** the schema tests — expect PASS.
- [ ] **Step 5: Commit** `feat(db): dollar drawer and dollar payments (additive)`.

### Task 3: Settle and post USD payments

**Files:** Modify `src/server/domain/sale.ts`, `src/server/sales/sales.ts`; Test `tests/sales/sales.test.ts`.

**Interfaces:**
- Consumes: Task 1 functions; Task 2 columns.
- Produces: createSale `payments` accepts `{ method: "CASH"; currency?: "IQD" } | { method: "CASH"; currency: "USD"; usdMinor: money; amountMinor: money }` and `{ method: "CARD"; amountMinor }`. For USD, `amountMinor` is the client's dinar value; the server computes `usdToDinar(usdMinor, shift.usdRateMicro)` and rejects a mismatch with `RuleError("PAYMENT_RULE", { reason: "RATE_MISMATCH" })`. No rate on the shift: `RuleError("PAYMENT_RULE", { reason: "USD_NOT_AVAILABLE" })`. `settlePayments` receives dinar values only (USD rows converted before it) so its signature is unchanged; the stored USD row has `tenderedCurrency "USD"`, `tenderedForeignMinor = usdMinor`, `rateMicro`, `amountMinor` = dinar kept of that row, `tenderedMinor` = dinar value handed over. `SaleView.payments[]` gains `tenderedCurrency`, `tenderedForeignMinor`, `rateMicro` (nullable).
- Change rule: the change of a sale is paid from the dinar drawer; the change is attributed to the dinar CASH row if one exists, otherwise taken off the USD row's kept amount (the USD row keeps `amountMinor = tenderedMinor - change`).

- [ ] **Step 1: Write failing tests**: USD exact (20.17 USD at 1450 for 29,250 due: use the ceil chip value); USD overpay with dinar change; mixed USD + IQD; mixed USD + card; wrong dinar value for the dollars -> RATE_MISMATCH and no rows; no shift rate -> USD_NOT_AVAILABLE; same `saleKey` retry returns the sale, one USD row only; a dinar-only sale is byte-identical to today (existing tests untouched and passing).
- [ ] **Step 2: Run** `npx.cmd vitest run tests/sales` — expect the new tests FAIL.
- [ ] **Step 3: Implement** in `createInput` (discriminated union), `postSale` (resolve USD rows against the shift's `usdRateMicro`, then settle in dinars, then write rows), `readSale`.
- [ ] **Step 4: Run** `npx.cmd vitest run tests/sales` — expect PASS, including every old test.
- [ ] **Step 5: Commit** `feat(sales): take part of a sale in dollars at the shift rate`.

### Task 4: Shift open, rate, close with two drawers

**Files:** Modify `src/server/sales/shifts.ts`; Test `tests/sales/shifts-usd.test.ts`.

**Interfaces:**
- Consumes: Task 1 `validRateMicro`.
- Produces:
  - `openShift` input gains optional `openingUsdMinor: money` (default 0) and `usdRateMicro: bigint` (optional; refused unless USD enabled and `validRateMicro`; `openingUsdMinor > 0` requires a rate). When omitted, the last closed shift's rate of the business is NOT applied silently: the form pre-fills it, the server stores only what is sent.
  - New action `setShiftRate` (name `shift.rate`, permission `shift.manage`, OPEN shift only, `expectedVersion`, bumps version, audit) taking `{ shiftId, usdRateMicro, expectedVersion }`.
  - `closeShift` input gains optional `countedUsdMinor`. Required when the shift has a rate; `expectedUsdMinor = openingUsdMinor + sum(tenderedForeignMinor of USD payments)`; `differenceUsdMinor = counted - expected`. Dinar `expectedCashMinor = opening + dinar cash kept - dinar change given` (existing logic, now also net of the change given on sales whose cash was USD: change is already inside `amountMinor`, so confirm with the Task 3 attribution and test it).
  - `ShiftView` and `ShiftSummary` gain `usdRateMicro`, `openingUsdMinor`, `countedUsdMinor`, `expectedUsdMinor`, `differenceUsdMinor`; `ShiftSummary` gains `usdTenderedMinor` and `usdDinarMinor`.

- [ ] **Step 1: Write failing tests**: open with rate and opening dollars; refuse rate 0 / 99 / 20000 and rate without USD enabled; cashier cannot `setShiftRate` (FORBIDDEN), manager can, version bumps, VERSION_CONFLICT on stale; close with counted dollars -> expected and difference both drawers; USD sale then close: expected USD = opening + dollars taken; dinar expected excludes the dollar part and includes minus change; close of a shift with no rate behaves as today with USD fields null.
- [ ] **Step 2: Run** `npx.cmd vitest run tests/sales/shifts-usd.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** the changes above.
- [ ] **Step 4: Run** `npx.cmd vitest run tests/sales` — expect PASS.
- [ ] **Step 5: Commit** `feat(shifts): dollar drawer, shift rate and two-drawer close`.

### Task 5: The till UI: pay panel and shift forms

**Files:** Modify `src/app/retail/sell/{actions.ts,shift-forms.tsx,sell-screen.tsx}` and `_lib/*` (tender helpers `paymentsOf`), `sell.css`, `src/messages/{ar,ckb,en}.ts`; Tests `tests/ui/sell-ui.test.ts`, one e2e.

**Interfaces:**
- Consumes: Task 3 payment shape; Task 4 shift fields (the till loader passes `usdRateMicro` and whether USD is enabled).
- Produces (UI): method row **Cash IQD | Cash USD | Card** (Cash USD only when the shift has a rate); in USD mode the panel shows the due in dollars (`dinarToUsdCentsCeil`), chips (exact, 20, 50, 100 USD) and the keypad types dollars; "Still due" always in dinars; a big "Change due IQD"; mixed allowed. Open-shift form: opening dollars and rate (pre-filled from the last closed shift's rate, editable). Close form: counted dollars next to counted dinars, showing both differences. Receipt shows dollars taken, the rate and the dinar change. All state hidden when USD is off.
- Words (ar/ckb/en): Cash IQD, Cash USD, Rate, Dollars received, Change (dinars), Opening dollars, Dollars in drawer, Counted dollars.

- [ ] **Step 1: Write failing UI tests** (pay-panel states: USD hidden without a rate; USD selected shows dollars due and chips; mixed shows dinar still-due; RTL; keypad dollars) in `tests/ui/sell-ui.test.ts`, and an e2e that opens a shift with a rate, sells 20 USD cash for a dinar total, and closes with both drawers.
- [ ] **Step 2: Run** `npx.cmd vitest run tests/ui` — expect FAIL.
- [ ] **Step 3: Implement** the UI, following the existing till patterns, tokens and themes; read the Next docs named in AGENTS.md before touching Next APIs.
- [ ] **Step 4: Run** `npx.cmd vitest run` (whole suite) and `npx.cmd tsc --noEmit` and `npx.cmd eslint .` — expect PASS. Look at the screens in a real browser at 375px and desktop, Arabic and English, dark and light (real screenshots, opened and checked), and write what was and was not verified in `docs/superpowers/reports/usd-two-drawers-report.md`.
- [ ] **Step 5: Commit** `feat(till): pay in dollars, shift open and close with both drawers`.

## Rollout (not part of the build)

Additive migration; take a database backup before the deploy; Studio untouched. No push or merge without the owner's word.
