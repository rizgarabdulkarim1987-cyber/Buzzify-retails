# Retail packs: one engine, one product per business type

Decision of the owner (2026-11-04): supermarket, mobile shop and clothing shop each feel like their own
complete product, and there will be many more types later (perfume, stationery, electronics, ...). So
the types must not be separate codebases.

## Principle

- One engine, written and fixed once: catalog, stock ledger, sales and shifts, returns, accounting,
  staff and permissions, Studio link.
- A **pack** per business type decides what that shop sees. For the user it is a separate product with its
  own screens and words; nothing from another pack is reachable.
- Adding a type = one pack folder + tests. Not a new project.

## What a pack is

`src/packs/<type>/manifest.ts`, one per `RtActivityType` value that has a pack (MARKET first). A manifest
declares, as data:

- **home**: where a signed-in user lands (market lands in the till or the open-shift screen).
- **nav**: the sections the shop sees, each with route, label keys (ar, ckb, en) and the role that may open it.
- **capabilities**: the `Capability` values the pack switches on by default (SERIAL, BATCH, WEIGHT, VARIANTS,
  WARRANTY, CREDIT, HOLDS ...). `RtCapability` rows already exist per business; the pack gives the default set.
- **till**: which till layout and which extra till controls (weighing, serial/IMEI entry, size/colour picker).
- **productForm**: the extra fields on an item (expiry, IMEI tracking, size/colour matrix).
- **reports**: the reports it lists.

The engine reads `getPack(business.activityType)`; unknown or MIXED falls back to the market pack.

Guards: every route under a pack checks that the shop's pack owns it; another pack's URL answers 404.
Words: each pack has its own message namespace, and the existing word-guard test is extended per pack.

## Packs, in build order

1. **MARKET (supermarket)**: weighed items and weight/price barcodes, expiry and batches (FEFO, no expired sale),
   departments as till tiles, offers, damage and waste, fast scanning, returns, credit sales.
2. **ELECTRONICS (mobile shop)**: serial/IMEI per unit (never sold twice), warranty and claims, repairs,
   installments, trade-in. Repairs and trade-in are optional features.
3. **CLOTHING**: size/colour matrix created in one go, a barcode per variant, exchange, seasons and sale prices.
4. Later: BEAUTY (size, grade, tester), STATIONERY, MIXED.

## Engine work that every pack needs (built once, in this order)

1. Till v2 (touch POS layout, in progress), returns and exchange.
2. Accounting: day and shift close, expenses, suppliers and purchases, customer credit, profit and reports.
3. Suppliers, transfers, stock count (R6 of the main design).

## Acceptance

- A MARKET shop cannot open an ELECTRONICS URL and sees none of its words, and the reverse.
- A new pack needs only a folder, its messages and tests; no engine file changes.
- Two packs' till screens run on the same sale service; a sale made in either passes the same tests.
- The existing shop keeps working: its pack is derived from its current `activityType`.

## Not now

- Separate repositories or domains per type. Possible later for one big customer because packs are already
  separated; not needed to ship.

## Open points for the owner

- Is MARKET the same as supermarket (assumed yes)?
- Which `activityType` does a mobile shop use: ELECTRONICS (assumed)?
- Does the shop owner pick the type in Studio when creating the shop (assumed), and can it change later (assumed no, support changes it)?
