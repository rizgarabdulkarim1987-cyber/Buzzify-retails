# Expenses paid from the cash drawer

Status: written without owner questions on 2026-11-05 (owner said "continue without questions"); every call below marked **[my call]** is a default the owner can change. Nothing built yet.
Why: a shop pays small cash costs from the drawer during the day (a delivery man, ice, cleaning, an advance). Today the drawer then looks short at close and nobody knows why. Expenses make the close add up and are the first piece of "accounting".

## What the cashier sees
1. On the till, a function key **Expense** opens a panel: amount (the same keypad, dinars), a category card (fixed list, below), a note (required for "Other"), **Save**. It posts at once on the open shift and shows in a short list "Today's expenses" on that panel.
2. The close-shift screen shows the line **Expenses** (total) in the summary; the expected cash is `opening + cash taken - change given - expenses`. The expenses of the shift are listed (time, category, amount, note, who).
3. A manager (or owner) can **void** an expense of an OPEN shift with a reason (a mistake). It stays in the list struck through and no longer counts. A closed shift never changes, so nothing is voided after close.

## Categories (fixed list; key / ar / en) [my call]
supplies / مستلزمات, transport / نقل وتوصيل, utilities / كهرباء وماء, cleaning / تنظيف, maintenance / صيانة, wages / أجور وسلف, meals / ضيافة, other / أخرى. ckb names are a first draft for native review. Owner-made categories are a later step.

## Rules
- Dinars only in this slice [my call]; a dollar expense is a later step. The amount must be > 0 and at most the cash the drawer is expected to hold now (no expense that would make the dinar drawer negative) [my call: refused with `EXPENSE_EXCEEDS_DRAWER`].
- Who: OWNER, MANAGER and CASHIER may record on their own OPEN shift (new permission `expense.create`); void needs `shift.manage` (OWNER, MANAGER). An ACCOUNTANT or AUDITOR only reads (through reports later) [my call].
- Idempotent: the client sends an `expenseKey` (unique per business); a retry returns the expense already posted and writes nothing.
- Immutable: no edit. A mistake is voided and re-entered; both stay visible and audited.
- Locks: the same `shift:<id>` lock a sale and the close take, so an expense and a close never interleave.
- Audit: record and void are audited like sales and shifts.

## Data (one additive migration)
`RtExpense`: `id`, `businessId`, `branchId`, `shiftId` (composite key to the shift in the same branch, like `RtPayment`), `categoryKey` (enum `RtExpenseCategory`), `amountMinor BigInt`, `currency Currency`, `note String?`, `expenseKey String`, `createdById`, `createdAt`, `voidedAt DateTime?`, `voidedById String?`, `voidReason String?`.
CHECKs: `amountMinor > 0`; the three void fields all null or all set; `categoryKey = 'OTHER'` needs a non-empty note. Unique `(businessId, expenseKey)`. Index `(businessId, shiftId)`.
`RtShift` gets nothing new: the expected cash at close is computed (and still stored in `expectedCashMinor` as today).

## Words (ar / ckb / en, own-words guard applies)
Expense, Expenses, Today's expenses, Category and the eight category names, Note, Void, Void reason, Voided, "Not enough cash in the drawer".

## Tests
Server: record, drawer never negative, idempotent retry, cashier on own shift only (not another's, not a closed shift), void by manager only, void needs a reason, voided does not count, close expected cash subtracts expenses, a close and an expense racing (locks), "Other" without a note refused. Schema CHECKs. UI: panel states, RTL, list, void, close summary with and without expenses, 375px, dark and light.

## Not in this slice
Dollar expenses, owner-made categories, expense reports by day/branch, receipts photos, supplier payments (own slice next), approval limits per role.
