# Drawer expenses Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A seller records a cash expense on the open shift; the close subtracts it; a manager can void a mistake.

**Architecture:** One additive migration (`RtExpense`), a new `src/server/sales/expenses.ts` with defineAction actions under the shift lock, the close computing expected cash with expenses, a till panel and a close-screen section.

**Tech Stack:** Next.js (read `node_modules/next/dist/docs/` before UI work, see AGENTS.md), Prisma 7 + Postgres, zod, vitest, Playwright. Messages in `src/messages/{ar,ckb,en}.ts`, own-words guard in `tests/messages`.

**Spec:** `docs/superpowers/specs/2026-11-05-retail-drawer-expenses-design.md`

## Global Constraints

- Dinars only; amount > 0; the dinar drawer never goes negative: refuse with `RuleError("EXPENSE_EXCEEDS_DRAWER")` (add the code where error codes live, with ar/ckb/en messages).
- Locks: `shiftLock(shiftId)` from `src/server/sales/shifts.ts`. Idempotent by `expenseKey` unique per business.
- Permission `expense.create`: OWNER, MANAGER, CASHIER. Void uses existing `shift.manage`. Add to `PERMISSION_LIST` and `ROLE_PERMISSIONS`; fix any test that lists permissions exhaustively.
- Categories enum `RtExpenseCategory`: SUPPLIES, TRANSPORT, UTILITIES, CLEANING, MAINTENANCE, WAGES, MEALS, OTHER. OTHER needs a non-empty note.
- Additive migration; hand-written CHECKs as in the spec. A closed shift never changes: no expense or void on a CLOSED shift (`SHIFT_NOT_OPEN`).
- Existing close math unchanged when a shift has no expenses. RTL, 375px, dark and light, 44px targets; ar, ckb, en words; own-words guard passes. No push, merge, deploy.
- Commit trailer: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Review Focus

- Two taps on Save (same `expenseKey`) never record two expenses.
- An expense that equals the whole drawer is allowed; one dinar more is refused; nothing is written on refusal.
- A cashier cannot record on, void on, or read-write another person's shift; a cashier cannot void at all.
- Voiding an already voided expense does nothing wrong (refused with a clear code, not a double effect).
- Close with expenses and USD together: dinar expected subtracts expenses only; dollar drawer untouched.
- 40 expenses in one shift: the list and close screen stay usable at 375px.

## File Structure

- Create `prisma/migrations/20261105200000_drawer_expenses/migration.sql`; modify `prisma/schema.prisma`.
- Create `src/server/sales/expenses.ts`; modify `src/server/sales/shifts.ts` (expected cash and summary), `src/server/domain/permissions.ts`, the error-code list and messages.
- Modify `src/app/retail/sell/{actions.ts,sell-screen.tsx,shift-forms.tsx,_lib/*,sell.css}`, `src/messages/{ar,ckb,en}.ts`.
- Tests: `tests/schema/expenses.test.ts`, `tests/sales/expenses.test.ts`, extend `tests/sales/shifts-usd.test.ts` or a new `tests/sales/shifts-expenses.test.ts`, `tests/ui/sell-ui.test.ts`, one e2e `tests/e2e/sell-expenses.spec.ts`.

### Task 1: Migration, schema, permission

**Files:** migration, `prisma/schema.prisma`, `src/server/domain/permissions.ts`; Test `tests/schema/expenses.test.ts`, existing permission tests.

**Interfaces:** Produces model `RtExpense` (fields in the spec), enum `RtExpenseCategory`, permission `"expense.create"`.

- [ ] **Step 1: Write failing tests**: valid row accepted; amount 0 rejected; half-set void fields rejected; OTHER with empty note rejected; duplicate `(businessId, expenseKey)` rejected; a CASHIER `can(role, "expense.create")` true, ACCOUNTANT false.
- [ ] **Step 2: Run** `npx.cmd vitest run tests/schema tests/domain` - expect FAIL.
- [ ] **Step 3: Implement** schema, hand-written migration with CHECKs, `npx.cmd prisma generate`, the drift check (`prisma migrate diff --from-migrations prisma/migrations --to-schema prisma/schema.prisma --exit-code` against a shadow database as CI does), permission entries.
- [ ] **Step 4: Run** the same - expect PASS.
- [ ] **Step 5: Commit** `feat(db): drawer expenses (additive) and the expense.create permission`.

### Task 2: Record and void (server)

**Files:** Create `src/server/sales/expenses.ts`; Test `tests/sales/expenses.test.ts`.

**Interfaces:**
- Consumes: `shiftLock`, `openShiftOf`, `shiftTotals` from `shifts.ts`.
- Produces: `recordExpense` (name `expense.record`, permission `expense.create`, input `{ expenseKey: string, categoryKey, amountMinor: money, note?: string }`, returns `ExpenseView`); `voidExpense` (name `expense.void`, permission `shift.manage`, input `{ expenseId, reason: string(1..500) }`); `listShiftExpenses` (name `expense.list`, permission `sale.create`, input `{ shiftId }`, own shift or any in one's branches with `shift.manage`); `type ExpenseView = { id, shiftId, categoryKey, amountMinor, note, createdById, createdAt, voidedAt, voidReason }`; `shiftExpensesTotal(tx, shiftId): Promise<bigint>` (non-voided sum), exported for `shifts.ts`.

- [ ] **Step 1: Write failing tests** for each Review Focus line and each rule in the spec (record, drawer exactly equal allowed and +1 refused with nothing written, idempotent retry, own shift only, closed shift refused, void by manager, cashier void FORBIDDEN, double void refused, voided excluded from the total, OTHER without note INVALID_INPUT).
- [ ] **Step 2: Run** `npx.cmd vitest run tests/sales/expenses.test.ts` - expect FAIL.
- [ ] **Step 3: Implement** the actions (lock the shift first, re-read it OPEN, compute the current expected dinar drawer = opening + cash kept - change - existing non-voided expenses, using the one helper the close also uses so both stay equal).
- [ ] **Step 4: Run** it - expect PASS.
- [ ] **Step 5: Commit** `feat(expenses): record and void cash expenses on an open shift`.

### Task 3: Close and summary subtract expenses

**Files:** Modify `src/server/sales/shifts.ts`; Test `tests/sales/shifts-expenses.test.ts`.

**Interfaces:** `ShiftSummary` gains `expensesMinor: bigint`; `expectedCashMinor` (summary and close) = `opening + cash movement - expensesMinor`; `ClosedShift` carries it; the dollar fields are untouched. One shared function computes the dinar expected so `recordExpense`, `shiftSummary` and `closeShift` agree.

- [ ] **Step 1: Write failing tests**: shift with sales, expenses and a voided expense: summary and close expected cash and difference are right; no expenses: identical to before (existing tests unchanged and passing); USD sale + expense: dollar drawer untouched.
- [ ] **Step 2: Run** `npx.cmd vitest run tests/sales` - expect new FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx.cmd vitest run tests/sales` - expect PASS.
- [ ] **Step 5: Commit** `feat(shifts): the close subtracts the shift's expenses`.

### Task 4: Till UI

**Files:** Modify the sell files named above, messages; Test `tests/ui/sell-ui.test.ts`, `tests/e2e/sell-expenses.spec.ts`.

**Interfaces:** Consumes Tasks 2-3. Produces: an **Expense** function key and panel (keypad dinars, eight category cards in the till card style, note field, Save, today's list with void for managers), and an "Expenses" line plus list on the close screen. Hidden never; shown to anyone who can sell.

- [ ] **Step 1: Write failing UI tests** (panel states, OTHER needs a note, drawer-exceeded message, list with a voided row, close summary with and without expenses, ar/ckb/en words, RTL) and an e2e: cashier records an expense at 375px Arabic, closes with the expected cash reduced; manager voids it.
- [ ] **Step 2: Run** `npx.cmd vitest run tests/ui` - expect FAIL.
- [ ] **Step 3: Implement** following the till patterns (read the Next docs named in AGENTS.md first).
- [ ] **Step 4: Run** the whole `npx.cmd vitest run`, `npx.cmd tsc --noEmit`, `npx.cmd eslint src tests`, the new e2e, and look at real screenshots (375x667 and 375x812, 1280, Arabic dark, English light, a 40-expense list); write `docs/superpowers/reports/drawer-expenses-report.md` with what was and was not verified.
- [ ] **Step 5: Commit** `feat(till): record expenses from the till, see and void them at close`.

## Rollout (not part of the build)

Additive migration; database backup before deploy; no push or merge without the owner's word.
