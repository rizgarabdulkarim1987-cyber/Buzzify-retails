# Drawer expenses: report

Branch `retail-expenses`, four commits on top of main. Spec: `docs/superpowers/specs/2026-11-05-retail-drawer-expenses-design.md`; plan: `docs/superpowers/plans/2026-11-05-drawer-expenses.md`. Nothing was pushed, merged or deployed.

## What was built

1. Migration `20261105200000_drawer_expenses` (additive): enum `RtExpenseCategory`, table `RtExpense`, hand-written CHECKs (`amountMinor > 0`; the three void fields all null or all set; OTHER needs a non-blank note), unique `(businessId, expenseKey)`, index `(businessId, shiftId)`. Permission `expense.create` (OWNER, MANAGER, CASHIER). `RtExpense` registered as a branch-scoped model in `scoped-db.ts`.
2. `src/server/sales/expenses.ts`: `recordExpense`, `voidExpense`, `listShiftExpenses`, `shiftExpensesTotal`. Error codes `EXPENSE_EXCEEDS_DRAWER`, `EXPENSE_VOIDED` (ar, ckb, en).
3. `src/server/sales/shifts.ts`: `expectedDinarMinor` is the one formula (opening + cash movement - expenses not voided) used by `recordExpense`, `shiftSummary` and `closeShift`. `ShiftSummary` and `ClosedShift` gain `expensesMinor`.
4. Till: an **Expense** function key (fifth key), a panel (keypad in dinars, eight category cards, note, Save, the shift's list with Void for managers and owners), and on the close screen an Expenses line plus a collapsed list.

## Verified (with the command that produced it)

See the numbers at the end of this file. Everything below was actually run.

- Schema: `tests/schema/expenses.test.ts` (6 tests): valid row, amount 0 and negative, half-set void fields, OTHER with empty or blank note, duplicate key, permission matrix.
- Server: `tests/sales/expenses.test.ts` (23 tests): every Review Focus line (double save with one key, parallel saves with one key, drawer exactly equal allowed and one dinar more refused with nothing written, retry not refused when the first save emptied the drawer, someone else's key not replayed, cashier cannot void, double void refused, closed shift refused, 40 expenses listed).
- Close: `tests/sales/shifts-expenses.test.ts`: summary and close subtract expenses, a voided one does not count, no expenses gives the old numbers, dollar sale plus expense leaves the dollar drawer untouched.
- UI: `tests/ui/sell-ui.test.ts` (new block): Save readiness, eight categories in three languages, empty panel, list with a voided row, void button only for managers, close summary with and without expenses, 40-row collapsed list, words guard on the new block, no fixed left or right in the new CSS.
- E2E, run by me with `next dev --webpack` through a temporary untracked Playwright config (deleted before the commit; Turbopack fails on this worktree's `node_modules` junction): `tests/e2e/sell-expenses.spec.ts`, 2 tests passed. Cashier at 375x667 in Arabic: Save button is 44px or more and never overlaps the last keypad row once scrolled into view, two quick taps record one expense, OTHER needs a note, 44,001 against a 44,000 drawer is refused with the drawer message and records nothing, no Void for a cashier, close shows Expenses 6,000, expected 44,000, counting 44,000 matches. Manager: records, voids with a reason, the row stays struck through, close shows no Expenses line and expected 20,000.
- Screens looked at, each opened and read (saved under `assets/expenses-*`): Arabic dark at 375x667, 375x812 and 1280 (till with the five keys, empty panel, panel after 40 saves, the 40-row list, the close screen with the collapsed and open list); English light at 375x667 and 1280 (panel, list, close); Sorani dark panel at 375x667; Arabic light void state at 375x812. No horizontal scroll at 375 on the panel and the close page (asserted in the e2e).

## Not verified

- Real devices, a real touch keyboard, and screen readers. The Save button label while saving and the live status line were not heard.
- Sorani close screen: Next reports a hydration mismatch in dev for the existing "Opened ..." date line in `ShiftSummaryView` (Node and the browser format Sorani dates differently). It is not from this slice, but the new list's time on the close page (`formatTime`) can show the same difference in Sorani.
- The CI drift check was run in its equivalent form: all migrations applied to the local dev database, then `prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code` printed "No difference detected". The exact CI form with a shadow database was not run (creating the shadow database needed a database login the tooling refused to write).
- Print layout and the other six roles' screens were not looked at.
- Task 4's UI unit tests were written together with the code, not before it; the one failure the first run showed (the close section needs the Next router) was a real defect and was fixed.

## Rulings (plan versus code or spec)

1. The plan lists `ExpenseView` without a name for who recorded it. Only the shift's owner can record on a shift, so the list shows the signed-in person's name (the shift's person) from the shell, not a per-row lookup.
2. `shiftExpensesTotal` is exported from `expenses.ts` as the plan says, but it is defined in `shifts.ts` and re-exported, so the two files do not import each other.
3. Task 1 also needed `RtExpense` in `scoped-db.ts` and the permission count tests (21 to 22); these are in the commits that needed them (the scoped-db registration is in the Task 2 commit).
4. Support access (`SALES_READ` in `src/server/admin/support.ts`) does not include `RtExpense`: the note field can hold personal remarks, and the spec does not ask for it. A deliberate default the owner can change.
5. A different person's `expenseKey` on the same business is refused (`INVALID_INPUT`) instead of returning their expense.
6. The close summary shows an Expenses line only when there is a non-zero total, so a shift without expenses looks exactly as before. The amounts are written without a minus sign (a minus next to Arabic-Indic digits renders on the wrong side in right-to-left lines).
7. The fifth function key is added next to the disabled Customer and Note keys (they stay).

## Open question for the owner

A manager can void only from their own till (the panel and the close page of their own shift). The server lets a manager void an expense on any open shift of their branches, but no screen lists other people's shifts yet, so a cashier's mistake cannot be voided by a manager from another device today. A "shifts of the branch" screen is the natural next step; it was not in this slice.

## Numbers

- Full suite, `vitest run --testTimeout 60000 --hookTimeout 60000` against a private database of the embedded Postgres (`TEST_DATABASE_URL` pointed at a database named `retails_test_expenses`, because other sessions on this machine use `retails_test` and a first run of mine collided with another vitest run and was discarded): 100 files, 1404 tests, all passed (before the close-versus-expense race test was added).
- After adding that test: `tests/sales/expenses.test.ts` + `tests/sales/shifts-expenses.test.ts` 28 passed. The whole suite was not run again after that one test, so the expected total is 1405 but only 1404 was observed in a whole-suite run.
- `npx.cmd tsc --noEmit`: no output (clean). `npx.cmd eslint src tests`: no output (clean).
- Playwright (webpack dev server, temporary config): `tests/e2e/sell-expenses.spec.ts` 2 passed. The rest of the e2e suite was not run.
