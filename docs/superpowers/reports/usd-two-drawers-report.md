# USD and IQD cash at the till, two-drawer shift close: report

Branch `retail-accounting-1` (worktree `till-v3`). Plan: `docs/superpowers/plans/2026-11-05-usd-iqd-two-drawers.md`.
Spec: `docs/superpowers/specs/2026-11-05-retail-usd-iqd-payment-design.md`. Local only: nothing pushed, merged or deployed.

## What was built (five commits)

1. `fx.ts`: `usdToDinar` (floor), `dinarToUsdCentsCeil`, `validRateMicro` (100 to 10,000 IQD per USD).
2. Migration `20261105100000_usd_drawer` (additive) and the schema: shift rate, opening/counted/expected/difference dollars; payment tendered currency, dollars handed over, rate; the hand-written CHECKs of the plan.
3. `createSale` takes cash in dollars (one entry at most), recomputes the dinars at the shift rate, refuses a client mismatch (`RATE_MISMATCH`) and a shift without a rate (`USD_NOT_AVAILABLE`); change is always in dinars.
4. Shifts: open with opening dollars and a rate; `setShiftRate` (manager only, OPEN shift, version bump); close with counted dollars; both drawers recorded.
5. The till UI: Cash IQD | Cash USD | Card, due in dollars with the rate, chips (exact, 20, 50, 100), keypad in dollars, "Still due" in dinars, a big "Change (dinars)", receipt with dollars, rate and dinar change; open and close forms with both drawers.

## Rulings (spec wins over plan, or the plan was silent)

- **20.17 vs 20.18.** The plan's example (29,250 IQD at 1,450 = 20.17 USD) is a display rounding. 20.17 dollars credits 29,246 dinars (4 short), so the exact chip is 20.18 (the ceil rule, plan Task 1) and the sale carries 11 dinars of change. A test pins both cases.
- **Dinar drawer.** For a dollar payment the dinar drawer moves by `amountMinor - tenderedMinor` (minus the change given from the dinar drawer); for a dinar payment by `amountMinor`. The plan said to confirm this attribution: it is tested (sale A, B, C in `tests/sales/shifts-usd.test.ts`). `cashMinor + usdDinarMinor + cardMinor = totalMinor` always. A shift whose cash was all dollars therefore shows a small negative "Cash" line (the change handed out); that is the drawer movement, not an error.
- **More than one dollar entry per sale** is refused (`INVALID_INPUT`); the UI sends one. Dinars that would all be change (dollars already cover the due) are `PAYMENT_RULE / CASH_NOT_NEEDED`, the same rule as cash over a full card.
- **Existing tests changed in four places only:** `SaleView.payments[]` now carries three nullable fields (plan interface), so two `toEqual` expectations got `null`s; `tillState` now also returns `usdEnabled` and `lastUsdRateMicro` (the open form pre-fills the last closed shift's rate), so one `toEqual` got those two keys; the `ShiftDto` fixture got the new fields.
- **Pre-filled rate** is replaced by the first digit typed (so it is never deleted key by key); the server stores only what the form sends.
- **Closing a shift with a rate requires counted dollars; without a rate they are refused** (`INVALID_INPUT`).
- Server side, `createSale` does not re-check `enabledCurrencies` (only the shift rate, which can only be set while USD is enabled); the till hides dollars when either is missing.

## Verified (commands run; see the final numbers in the hand-off)

- `tests/sales/fx.test.ts`: 7 tests, including 200 random dinars and rates for the ceil rule.
- `tests/schema/usd.test.ts`: 8 tests (CARD with dollars, half-set fields, zero rate/dollars, open shift with closing dollars, wrong difference; valid rows accepted; existing rows keep null/0).
- `tests/sales/sales.test.ts` (10 new dollar tests), `tests/sales/shifts-usd.test.ts` (8): exact dollars, short dollars, overpay, mixed dollars + dinars, dollars + card, wasted dinars, rate mismatch writes nothing, no rate, same `saleKey` retry writes one dollar row, rates 0/99/20000 and rate without USD refused, cashier cannot set the rate (FORBIDDEN), manager can, stale version conflicts, two-drawer close, no-rate shift closes as before.
- `tests/ui/sell-ui.test.ts`: pay states (no rate hides dollars; dollars selected shows due in dollars and the rate; mixed still-due; chips; keypad in dollars; receipt and shift summary with and without dollars), Arabic digits, the new words in ar, ckb, en; the own-words guard (`tests/messages`) passes.
- Migration drift check against a local shadow database: "No difference detected".
- Playwright `tests/e2e/sell-usd.spec.ts` (new): at 375px in Arabic, a cashier opens a shift with 50,000 IQD, 100 USD and rate 1,450, sells a 29,250 item paying the exact 20.18 chip (change 11 dinars), sees the receipt, and closes both drawers (49,989 IQD and 120.18 USD, both match); a second test checks the pre-filled rate is replaced by the first digit.
- Real screens in the browser (Playwright Chromium, dev server on webpack), every screenshot opened and checked: 375px Arabic dark, 375px English light, 375px Sorani light, 1280px Arabic light, 1280px English dark; each through open form, pay (dinars), pay (dollars exact), pay (mixed, still due), mixed covered, receipt, close with a dollar shortfall, closed. Saved under `docs/superpowers/reports/assets/usd-*.png`.

## Not verified

- No iPad/Safari or real phone; Chromium only. No printed receipt.
- The Next dev server printed a hydration warning pointing at the "opened at" time of the shift summary (server and browser time zones); the line is not part of this change, and I did not check it on the base commit.
- The whole Playwright suite was not run to the end: it did not finish in over an hour on this machine under the webpack dev server (see the hand-off for which specs did run).
- Turbopack: `next dev` fails on this worktree's `node_modules` junction, so all browser work used `next dev --webpack` through an untracked local config (deleted before committing). Production build (`next build`) was not run.
- Studio, deploy and a database backup are not part of this change.

## Final run numbers

- Full vitest: 97 files, 1359 tests, all passed (622 s, with `--hookTimeout 60000 --testTimeout 60000` because the machine was loaded).
- `npx tsc --noEmit`: clean (exit 0).
- `npx eslint src tests`: clean (exit 0). `npx eslint .` over the whole worktree reports 778 errors and 8910 warnings, coming from generated build output folders and not from files changed here; I did not clean them up.
- Playwright: only `sell-usd.spec.ts` (2 tests) was confirmed passing; the full suite was not finished. One catalog.spec failure ("qe-added-item" count) was seen once under load and not investigated.

## Fix: pay screen at 375px (after review)

Defects seen in the first screenshots: the pay button covered the last keypad row, and the quick chips wrapped into 3 + 1.

- On phones the pay panel is now a column: the head and the pay button stay fixed, only the amounts and keys scroll between them (`.till-pay-body`), so the button never covers a key. The quick chips are one even row of equal width (phone only; at 1280px the CSS is unchanged, including its 3 + 1 chip wrap, which I left alone because the request was that desktop not change).
- Checked with a temporary Playwright script (deleted, with its extra seed products) on a real dev server: at 375x667 and 375x812, Arabic dark and English light, for dinar, dollar exact, mixed (still due) and a 15-line ticket paid in dollars, dinars and card, the last control (clear) ends above the pay button when the body is scrolled to its end, all chips share one top, and there is no sideways scroll. All 6 runs (including 1280x800) passed. I opened the screenshots myself: Arabic and English at both heights show no overlap, one chip row and the keypad reachable by scrolling; on the 15-line ticket the amounts, card line and zero change read correctly. At 667px the amounts scroll out of view while the keys are in view (by design). Saved as `assets/fix-*.png`.
- The Next dev-tools badge sits over the pay button's corner in screenshots; it exists only in dev.
- Re-run: tests/ui + tests/messages 16 files, 252 tests passed; `tsc --noEmit` clean; `eslint src tests` clean; `sell-usd.spec.ts` 2 passed (the first try failed on the login redirect during the dev server's first compile, the rerun passed).
