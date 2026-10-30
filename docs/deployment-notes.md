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

## Checks before and after deploying

- `npx prisma migrate diff --from-migrations prisma/migrations --to-schema prisma/schema.prisma --exit-code`
  (a shadow database from `SHADOW_DATABASE_URL`) prints nothing and exits 0.
- After deploying, `rebuildBalances(tx, businessId, { fix: false })` (src/server/stock/ledger.ts)
  returns no mismatches for each business. It is read-only unless `fix: true`.
