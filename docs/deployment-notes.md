# Deployment notes

Nothing here has been deployed. No migration has been applied to production, and the R2 branch
(`r2-stock`) is not merged. The design's rule stands: no `prisma migrate deploy` against production
without explicit approval and a fresh backup.

## Database

- PostgreSQL 15 or newer. The R2 stock tables use `NULLS NOT DISTINCT` unique keys (one balance row
  per location and variant when there is no batch); CI runs on 17.

## Migrations added by R2 (stock)

Applied in this order by `prisma migrate deploy`, after every R0 and R1 migration:

1. `20261030100000_stock`: batches, stock documents and lines, the movement ledger, the cached
   balances and the document counter; `RtImportBatch.kind` (existing rows become `CATALOG`). It
   also has hand-written parts Prisma cannot express: the two `NULLS NOT DISTINCT` unique indexes,
   the CHECK constraints (among them `RtStockBalance.qty >= 0`) and the trigger that refuses UPDATE
   and DELETE on `RtStockMovement` (append-only; TRUNCATE is not covered).
2. `20261030110000_stock_direction`: the direction (IN / OUT) of adjustments and write-offs, with two
   hand-written CHECKs (direction matches the kind; an adjustment or write-off has a reason).
3. `20261030120000_variant_stock_started`: `RtVariant.stockStartedAt`, backfilled from the first
   movement of each variant (no rows on a database without stock).

The migrations only add tables, columns, indexes and constraints. The only data they write is the
default for `RtImportBatch.kind` and the `stockStartedAt` backfill. The drift check below does not
see the hand-written parts, so review them in the SQL.

## R1b (AI receipt intake and barcode scan)

Branch `r1b-ai-intake`, not merged. Nothing of it is deployed.

### Environment

| Variable | Meaning |
| --- | --- |
| `ANTHROPIC_API_KEY` | Key for the model provider. Read on every call; when it is missing, every AI read fails as `AI_UNAVAILABLE` (the quota is refunded), and the app keeps working. Never commit it. |
| `INTAKE_MODEL` | Model id. Default `claude-sonnet-5-5`. |
| `INTAKE_PROVIDER` | Leave unset in production. `fake` selects the test provider only outside production (`next dev`, e2e). With `NODE_ENV=production` and `fake`, every read fails closed as `AI_UNAVAILABLE`; fabricated receipts are never served. |
| `INTAKE_TIMEOUT_MS` | Timeout of one provider call. Default 60000. |

`INTAKE_FAKE_FILE` is test-only (the e2e server's scenario file). It is never read in production.

### Migrations added by R1b

Applied in this order by `prisma migrate deploy`, after every R2 migration:

1. `20261031100000_ai_intake`: consent columns on `RtBusiness`, `RtIntake`, `RtIntakeFile` (page
   bytes in the database) and `RtAiUsage` (half units per business and month), with hand-written
   CHECKs.
2. `20261031110000_intake_reading_lease`: the read lease on `RtIntake` and `RtIntakeFile.size`,
   backfilled from the stored bytes, with a CHECK `size >= 0`.

Both only add. `20261031100000_ai_intake` was edited in place once during development (an index
on `RtIntake(businessId, createdAt)` was added). A dev or test database created from the earlier
version has a different checksum: recreate it (or `prisma migrate reset` it). Production never had
that migration.

### Behaviour to configure and know

- **Master switch.** `ai.intake` is a per-shop feature override that a platform super admin sets
  on `/admin` with a reason. No row means off. When it is off, every AI action and every read of a
  receipt is refused (`AI_DISABLED`). A typed or camera-decoded barcode lookup does not use AI and
  keeps working.
- **Quota.** `RtPlan.aiMonthly` is the number of reads per month. A receipt read costs 2 half
  units and an AI barcode read costs 1, so the limit is `aiMonthly * 2` half units. `aiMonthly = 0`
  closes the feature for that plan. The month is counted in the business's time zone. A failed
  read (`AI_UNAVAILABLE`, `AI_BAD_OUTPUT`, no consent) is refunded once. An unreadable page
  (`INTAKE_NOT_READABLE`) is still counted. Set `aiMonthly` per plan before enabling a shop.
- **Owner consent.** Before the first read, the owner accepts the consent text, version 1
  (`CONSENT_VERSION` in `src/server/intake/consent.ts`, text `stock.intake.consent.v1` in
  `src/messages/{ar,ckb,en}.ts`). The text names Anthropic and says images are not used for
  training. Raising the version voids every earlier consent. The owner can withdraw consent at
  any time, also with the switch off or while read-only. Withdrawing stops new reads; it deletes
  nothing.
- **Image retention.** Page bytes live in `RtIntakeFile` and are pruned when a new receipt is
  uploaded, up to 20 intakes per upload:
  - finished intakes (failed, discarded, or drafted with the draft posted or deleted): 30 idle days;
  - open intakes (uploaded or read, not drafted): 90 idle days;
  - never while a read is running, nor while the draft is still a draft.

  The intake row (hash and extracted result) stays. There is no scheduled job: a shop that uploads
  nothing keeps its pages. Stored pages also count against the plan's `storageMb`.
- **Who can read.** A receipt read needs `ai.use`, `stock.receive` and `cost.view` (the OWNER
  today; MANAGER and PURCHASING lack `cost.view`). An AI barcode read needs `ai.use` and
  `catalog.manage`.

### Before launch

- Anthropic key: who owns the account and pays for it.
- A native speaker reviews the Kurdish (ckb) texts.
- The owner, or legal, approves the consent text (v1).
- Decide whether `cost.view` stays required for receipt reading, or whether MANAGER or PURCHASING
  should get it.
- Run an accuracy trial on real supplier receipts before shops depend on it.
- Later Core integration: the key, the per-shop switch and the plan quotas move to the Core super
  admin. Retails then reads them from Core; there is no AI key screen in Retails.
- The scan screen loads the zxing wasm through the route `src/app/retail/catalog/scan/reader-wasm`.
  A `output: "standalone"` build needs `outputFileTracingIncludes` for the zxing-wasm `.wasm` file.
- GTIN canonicalization is still pending. A 12-digit UPC-A and the same code as a 13-digit EAN
  ("0" + 12 digits) are different codes today, both for lookup and for uniqueness, so a shop can
  create a duplicate item for one product. Fix this before real use.

## Checks before and after deploying

- `npx prisma migrate diff --from-migrations prisma/migrations --to-schema prisma/schema.prisma --exit-code`
  (a shadow database from `SHADOW_DATABASE_URL`) prints nothing and exits 0.
- After deploying, `rebuildBalances(tx, businessId, { fix: false })` (src/server/stock/ledger.ts)
  returns no mismatches for each business. It is read-only unless `fix: true`. It is a code-level
  call only: no script or admin screen runs it yet. Call it from a one-off script or a REPL with a
  transaction client of that business.

## Security notes

- The movement ledger's append-only trigger refuses UPDATE and DELETE, not TRUNCATE. TRUNCATE (and
  dropping the trigger) is prevented only if the production application connects with a restricted
  role that does not own the tables and has no TRUNCATE grant. Do not run the app as the table
  owner or a superuser.
- A support grant with the `STOCK_READ` scope lets platform support read the business's stock,
  including its costs and values. Grant it knowing that.
- In the opening-stock import, a role without `cost.view` (for example MANAGER) sees every column
  the server recognizes as a cost column blanked. A cost column whose header is not recognized (not
  auto-mapped, and never mapped as cost) is just another column, so its cells show in clear.
