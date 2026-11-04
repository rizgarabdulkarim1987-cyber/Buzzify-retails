# POS till v2: report

Branch `retail-pos-till-v2` (from `main` at 0345eb2), worktree `.claude/worktrees/pos-till-v2`.
Local commits only. Nothing was pushed, merged or deployed.

## Why

The owner said the first till looked like an admin app: lists, small cards and "coming in later
releases" text. He asked for a real touch till ("buttons, create sales, close the shift, very easy").
This branch rebuilds the sell screens and the market home. The backend rules stay as they were: money
in integer minor units, IQD with no fractions, shift rules, idempotency keys, PRICE_CHANGED handling,
and held carts stored on the device.

## What changed

- **Sale screen** (`src/app/retail/sell/sell-screen.tsx`, `sell.css`). On wide screens it has three
  columns:
  - a column of big coloured category tiles;
  - a grid of product tiles, each with a photo slot (until the catalog has photos it shows the name's
    first letter, skipping the Arabic article "ال"), the name on up to two lines and a large price;
  - a full-height cart with lines, - / quantity / + controls, line totals, item count, subtotal, a very
    large TOTAL and one huge green PAY button.

  The till uses its own slim top bar: shop, branch, till operator, the search/barcode field and a Menu
  button. The back-office shell header is hidden on this screen.
- **Menu** (a drawer): Hold cart, Clear cart, Close shift, the held carts with Resume, Shop menu,
  language and Sign out. Nothing else sits on the sale screen.
- **Numpad** (`Numpad` in `_lib/views.tsx`, pure logic in `_lib/till.ts`). Big keys in calculator
  layout (7-8-9 on top in every language). It has a "000" key for dinar and a decimal key where the
  value allows decimals (USD, weights). It also has backspace and Clear. A physical keyboard or USB
  numpad feeds the same keys, Arabic-Indic digits included. The numpad is used for:
  - editing a quantity: tap the quantity on a line; 0 removes the line; weighed items take the unit's
    decimals;
  - the cash received on the pay screen;
  - opening cash and the counted cash at close.
- **Pay screen**: the amount due, cash received, and change (or still due) in very large type, a row
  of quick amounts (exact amount first, then likely notes), the numpad, card for all or the rest, and
  a huge Complete sale button. Enter completes the sale and Escape goes back.
- **Receipt**: a big "Sale complete", the total, the change in very large green type, then New sale
  (focused) and Print. Printing still uses the 80 mm print style.
- **Open / close shift**: the numpad replaces the text box. Close shows the summary beside the count,
  and the difference updates live.
- **Home** (`src/app/retail/home/page.tsx`): anyone with `sale.create` and a branch is sent straight
  to `/retail/sell`. That page shows open shift if there is no open shift, otherwise the sale screen.
  Sign-in still lands on `/retail/home`, so no login files were touched. `/retail/home?menu=1`, linked
  from the till's Menu, shows at most four big tiles (Sell, Items, Stock, Close shift). Setup, Scan, AI
  settings and Switch branch sit under a small "More" (`<details>`). The home no longer shows the
  "coming in the coming releases" text.
- **Read model** (`src/server/sales/catalog.ts`), with no new feature: every tile now carries its
  top-level `categoryId`, which the till colours it by, and browsing takes an `offset` for "Show more
  items". Both are covered by `tests/sales/sales.test.ts`.
- **Messages**: a new `till` block in `ar`, `ckb` and `en`, added before `errors` so merges stay easy.
  The person at the till is called أمين الصندوق / بەرپرسی سندوق / Till operator. No other product's
  words are used. A test guards both the key parity and this wording.
- New icons: Menu, Close, Backspace (it mirrors only outside the LTR numpad), Drawer and Grid.

## Layout decisions

- The columns follow the grid's flow, not left/right rules. In ar and ckb the categories are on the
  right and the cart on the left. English mirrors this with no extra CSS.
- At 56rem (896px) and wider: rail `clamp(8rem, 11vw, 9.5rem)`, cart `clamp(19rem, 30vw, 26rem)`. This
  gives 4 tile columns at 1280px and 3 at 1024px.
- Narrower than 56rem (phones): categories become a horizontal strip of big chips, and the grid is two
  columns at 375px. A fixed bottom bar shows the item count, the total and Pay. Tapping the count and
  total opens the cart as a bottom sheet with its own PAY. The pay screen is compacted so it fits one
  375x812 screen (checked: no overflow).
- Touch targets are at least 56px (`--till-hit: 3.5rem`). Keys and quick notes are 64px, and PAY is
  80px.
- Tiles use `content-visibility: auto`. The grid shows one category or search at a time, 60 items per
  page with "Show more items". This keeps 2000 items smooth without a virtualisation library.
- Scanner: printable keys typed outside a field go to the search box. Enter with a single barcode hit
  adds the item and clears the box. The search box is focused automatically only on fine-pointer
  devices, so a touch keyboard does not pop up.
- Motion: short press scale, a highlight flash on the touched line, sheet slide and overlay fade.
  `prefers-reduced-motion` turns all of it off.
- Colour: the existing tokens, plus one PAY green and eight category tones. Each tone is a strong
  colour that keeps white text at 4.5:1 or better, plus a soft tint of it.
- Design process: I ran impeccable with no PRODUCT.md, as an extension of the existing tokens; I am a
  subagent and could not interview the owner. The impeccable detector reported no findings on
  `src/app/retail/sell` and `src/app/retail/home`. The 21st CLI is not installed, so no 21st components
  were used; the project has no Tailwind or shadcn.

## Verification

- `tsc --noEmit`: clean. `eslint src tests`: clean.
- `vitest`: `tests/ui/sell-ui.test.ts` and `tests/sales/sales.test.ts` pass (44 tests), including
  these new ones:
  - numpad editing rules;
  - keyboard-to-key mapping;
  - category tones and initials;
  - tile, quantity button and numpad markup;
  - till message parity and the words guard;
  - paging with offset;
  - `categoryId` on tiles.

  Full suite on my own Postgres (port 54339): 1095 passed, 21 failed across 13 files I did not
  touch (catalog search, schema/stock, intake barcode, core state, setup progress, and others). 12 of
  the failures were "timed out in 5000ms", and one was a deadlock. I reran four of those files alone
  and a *different* 2 tests failed, again on timing. This points to load on the shared machine
  (several agents running Postgres, dev servers and suites at once), not to this change. It should be
  rerun on a quiet machine before merging.
- Browser check (built-in browser, `next dev` on :3117, local embedded Postgres, database
  `retails_dev_till`, seeded with `tests/e2e/seed.ts` fixture accounts, signed in as the e2e owner):
  - Imported the 30 items of `docs/samples/market-sample-items.xlsx` through the real import screens:
    upload, column mapping, preview (30 new, 0 rejected), save.
  - The file has no stock. The first sale was refused with "not enough stock", which is correct. I
    posted opening stock (40 of each item) with the stock module's own `saveStockDraft` /
    `postStockDocument` from a throwaway script that was not committed.
  - 1280x800, Arabic: opened the shift with 50,000 on the numpad. Added biscuits by tile twice. Typed
    the sugar barcode like a scanner and pressed Enter: it was added and the box cleared. Changed sugar
    to 4 on the numpad. Total 6,000; cash 10,000 on the numpad; change 4,000. The receipt showed
    receipt no. 1 with change 4,000.
  - 1024x768, English: the layout mirrored (categories left, cart right), with 3 tile columns.
  - 375x812, Arabic: the bottom bar, the cart sheet and the pay screen all fit. Paid 41,750 with the
    42,000 quick note: change 250, receipt no. 2.
  - Close shift: expected cash 97,750 (50,000 + 6,000 + 41,750). Counted 97,500, so the screen showed
    "short 250" live. Closed with the recorded difference.
  - `?menu=1` showed the four tiles and More. The page never scrolled sideways at any size.
- Fixed after the browser check:
  - the numpad display did not group thousands;
  - the out-of-stock flag cut the price off (moved onto the photo slot);
  - the 1024px cart was too wide (only 2 tile columns);
  - the pay screen overflowed a phone;
  - the language select inside the menu kept the old value.
- Screenshots: `assets/till-v2-desktop-ar.png`, `assets/till-v2-tablet-en.png`,
  `assets/till-v2-phone-cart-ar.png`.

## Not verified

- English at 1280 and 375, and Sorani (ckb) on screen. Their strings exist and parity is tested, but I
  did not look at those screens.
- Real finger taps and a real USB/Bluetooth scanner. Browser clicks were partly scripted DOM clicks
  because emulated-viewport coordinate clicks were unreliable in the pane. The scanner was simulated
  by typing digits and pressing Enter.
- The Playwright e2e suite was not run. `tests/e2e/shell.spec.ts` was updated for the new landing on
  `/retail/sell`. `tests/e2e/core-handoff.spec.ts` (the other agent's sign-in area) still expects
  `/retail/home` after a Studio sign-in. It will need the same change if that user can sell and has a
  branch.
- Printing to a real 80 mm printer, a PRICE_CHANGED retry, network-failure retry, held carts across
  reloads, and USD amounts on screen.
- 2000 items: not loaded. Smoothness rests on paging plus `content-visibility`.

## Gaps against the reference POS screens (not built: no backend support)

- Product photos: there is a slot, but the catalog has no images.
- Discounts, price override, returns/refunds and tax lines: the "subtotal" therefore always equals the
  total.
- Change in USD, and split tender beyond cash plus one card.
- A customer display, a cash-drawer kick and silent printing.
- Held carts stay on one device (unchanged ruling).
- English and Sorani product names fall back to Arabic when the catalog has none, which is the case
  for the sample file.
- "Market only": the till landing applies to every role that can sell. The shell does not expose the
  activity type, and the till is the only selling flow today.

## Notes for the coordinator

- Port 54329 was held by the sign-in agent's embedded Postgres
  (`.claude/worktrees/agent-af8794860d062ef4a/.data/pg`). The browser check and the first test runs
  went through that server, using my own database names (`retails_dev_till`, `retails_test_till`).
  Later that server was stuck in "starting up", so I ran my worktree's own data directory on port
  54339 for the final test run. I did not touch the other agent's server.
- `next dev` rewrote `tsconfig.json` for its `.next-till` build folder. I reverted that and did not
  commit it.
