# Paying in dollars and dinars at the till

Status: design approved by the owner on 2026-11-05 (the four defaults below stand); nothing built. Owner asked for it on 2026-11-05 ("when someone pays in dollars, what happens?").
Today: a sale is in the business default currency only. The schema has `Currency {IQD, USD}`, `RtBusiness.enabledCurrencies`
and `RtPayment.currency`, but no rate, no USD tender and no USD cash in the shift.

## What the cashier sees

1. Open shift: besides the opening cash in dinars, the cashier enters opening dollars (may be 0) and the day's rate
   ("1 USD = 1,450 IQD"). The rate is pre-filled from the last shift. Shown only when USD is in `enabledCurrencies`.
2. Pay screen: the method row is **Cash IQD | Cash USD | Card**. Prices and the total stay in dinars always.
   - Cash USD selected: the screen shows the due amount in dollars at the shift rate (e.g. 29,250 IQD = 20.17 USD), quick chips
     (exact, 20, 50, 100 USD) and the keypad types dollars.
   - Mixed payment is allowed: dollars first, then the rest in dinars. The screen always shows "Still due" in dinars.
   - Change is always given in dinars (a big "Change due IQD"). Change in dollars is not offered.
3. The receipt shows the dollars taken, the rate and the dinar change.

## Data (one migration, additive, nullable defaults so existing rows stay valid)

- `RtShift`: `usdRateMicro BigInt?` (IQD per 1 USD x 10^6), `openingUsdMinor BigInt @default(0)`, and at close
  `countedUsdMinor`, `expectedUsdMinor`, `differenceUsdMinor` (all nullable like the dinar ones). Rate edit while OPEN needs the
  manager role and bumps `version`.
- `RtPayment`: `tenderedCurrency Currency?`, `tenderedForeignMinor BigInt?` (USD cents handed over), `rateMicro BigInt?`.
  `amountMinor` and `tenderedMinor` stay in the sale currency (dinars): the dinar value credited and the dinar value handed over,
  so every existing total, report and CHECK keeps working. A USD payment is a CASH row with the three new fields set.
- CHECKs: `rateMicro > 0` when `tenderedForeignMinor` is set; both set or both null; a CARD never has them.
- Expected USD in the drawer at close = opening USD + USD tendered by the shift's sales (no USD change given, so nothing to net).
  Expected dinar cash = opening + dinar cash taken - dinar change (change of a USD payment is paid from the dinar drawer).

## Rules

- The rate is typed by a person for the shift. No live feed. A sale stores the rate it used, so a later rate change never alters a past sale.
- Dinar credited from dollars = USD cents x rate, rounded down to a whole dinar. Rounding the dinar change to the nearest 250 is
  an open point (below).
- Hidden entirely when USD is not enabled for the business or the open shift has no rate (the till then looks exactly as today).
- Sale posting stays idempotent (`saleKey`); the server recomputes the dinar value from the dollars and the shift rate and rejects a client mismatch.
- Returns and refunds (later) refund in dinars at the original sale's recorded rate basis; not part of this slice.

## Words (ar / ckb / en, own-words guard applies)
Cash IQD / Cash USD, "Rate", "Dollars received", "Change (dinars)", "Opening dollars", "Dollars in drawer".

## Tests
Server: USD-only exact, USD overpay with dinar change, mixed USD+IQD, rate mismatch rejected, no rate -> USD refused, idempotent retry,
close shift expected USD and dinar separately, existing dinar-only sales unchanged. UI: pay panel states, RTL, 15-lines ticket, keypad typing dollars.

## Rollout
Migration is additive; database backup before deploy; Studio is not touched. Build with the accounting slice (shift close) or right
after it, because the close screen must show both drawers.

## Open points for the owner (my defaults in brackets)
1. Round the dinar change to the nearest 250? [No, exact to the dinar; the cashier rounds by hand. A setting later.]
2. Allow giving change in dollars? [No.]
3. Who may change the rate during a shift? [Manager only; the cashier sets it only when opening.]
4. Other currencies (euro, Turkish lira)? [Not now; the model allows them later.]
