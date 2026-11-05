# One-screen till, slice 1: report

Branch `till-one-screen` (4 code commits on top of main + 3 docs commits). Spec: `docs/superpowers/specs/2026-11-05-one-screen-till-design.md`; plan: `docs/superpowers/plans/2026-11-05-one-screen-till.md` (Tasks 1 to 7). Nothing pushed, merged or deployed. No migration in this slice.

## Built
- `_lib/pager.ts`, `_lib/calc.ts` (pure, unit tested).
- `catalog.ts`: `SellItem.batches` and `earliestExpiry` (one read of balances + one of batches). `recent.ts`: `listRecentSales` (own open shift, newest first). `recentSalesAction`.
- `line-table.tsx` (fixed 46px rows, pages with arrows, X, stock and expiry chips, search results in the same rows), `side-column.tsx` (shift card, selected product with batches, receipts, calculator), `one-screen.css`, `sell-screen.tsx` rewritten around them. Open sales are tabs (the existing device store); X removes with a 6 second Undo bar; typing a quantity works in the big box; phone is two fixed panes.
- A cashier's till has no Expense key. Managers and owners reach the Expense panel from the Menu.

## Verified
- `eslint src tests` and `tsc --noEmit`: clean.
- Full vitest against a private database: 102 files, 1415 tests passed.
- E2E (webpack dev server, temporary untracked config, deleted): `till-one-screen`, `sell-usd` and `sell-expenses` specs pass together (5 tests). The new spec asserts at 1280x520 with 5 lines (pages shown), and at 375x667 in both panes, that the document and the line rows do not scroll; X and Undo; hold and switch; the cashier has no expense key in the menu; the calculator adds 7+5.
- Screens looked at: 1280x520 and 375x667 (sell pane and shift/receipts/calculator pane), Arabic, dark.

## Not verified
- A full-suite e2e run was green except one different test each time (first `till-one-screen`, before I fixed its dependence on a pre-filled dollar rate; second `intake.spec`, sign-in did not finish within 5 s on the cold dev server). Both runs: 41 of 42. `intake` alone failed on a different test of the same file (sign-in again). I did not compare against main.
- 40 lines were not driven in e2e (only 5 products are seeded); paging is covered by the pager unit test and the 5-line short-viewport check.
- English and Sorani screens, light theme, 1366x768 and real devices were not looked at.
- Print of the receipts card, expiry colouring at 30 days or fewer in the browser (no seeded near-expiry batch).

## Rulings (differ from, or add to, the spec)
1. Paying is still the full-screen pay step (cash, card, dollars, mixed), not an inline strip: moving it inline would drop mixed payments or rewrite the whole pay flow and its specs. Cost if wrong: the cashier still leaves the sale view to pay. Follow-up slice.
2. Department cards and category browsing are gone from the till (the table finds products by scan or name). The packs' department words remain for other screens. Cost if wrong: weighed goods without a barcode need a name search.
3. The server permission `expense.create` still includes CASHIER (only the till UI hides it); removing it means rewriting the 23 expense tests. Cost if wrong: a cashier could still call the action by hand.
4. Stock and expiry on a line come from the products loaded with the page and from items added this session; a reloaded held sale shows "-" until the item is scanned again.
5. Quick-add, the discount column, returns and manager PIN are slices 2 and 3.
