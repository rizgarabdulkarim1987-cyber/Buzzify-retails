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

## Studio (core) link: sign-in handoff

- Contract for Studio's `GET /api/retail/v1/handoff`: Retails sends `return`, `state` and
  `nonce` (= base64url(sha256(state))). Studio must copy that `nonce` query value unchanged into
  the token's `nonce` claim. Retails refuses a token whose nonce is not the hash of the state in the
  browser's cookie, so a token minted for one browser cannot be redeemed in another.
- Studio must set `emailVerified` truthfully. Retails links by `coreUserId` first; without that link
  it accepts only a verified email (an unverified one is refused, no user is created), never links
  by email to a platform admin, and refuses when several local users share the email ignoring case.
- When a snapshot changes the owner, the previous owner's active OWNER row in that business is
  deactivated (audit `core.owner.demote`); the new owner gets OWNER at their next Studio sign-in.
- Sessions last 12 hours at most (no sliding refresh), password sign-in included.

## Studio contract (Part B must implement)

Retails -> Studio calls. Base URL is `CORE_BASE_URL` (https required in production; redirects are
refused). Every request is signed with the `CORE_OUT_SECRET` headers (`x-bz-timestamp`,
`x-bz-signature`: HMAC-SHA256 over METHOD, pathname plus raw query, timestamp and SHA-256 of the raw
body; accepted skew 120 s) and has a 5 s timeout. Studio verifies with the matching secret.

- `GET /api/retail/v1/ai-config` -> `200 {"apiKey": string | null, "model": string | null}`.
  `apiKey: null`, or HTTP `404`, is the definitive "no key": Retails clears its cache and AI is
  unavailable. Any other status, a timeout, a network error or a malformed body is a failure:
  Retails skips Studio for 15 s, serves the last key for at most 1 h, then (production) AI is
  unavailable (`AI_UNAVAILABLE`) or (non-production) uses `ANTHROPIC_API_KEY`. Retails caches a
  key for 60 s per server process.
- `POST /api/retail/v1/identities` with `{"email": string, "name"?: string}` ->
  `200 {"coreUserId": string, "created": boolean, "emailVerified": boolean}`. `emailVerified` must be
  true only when Studio has verified ownership of that email. Retails links a local user to
  `coreUserId` only when it is true, the user is not a platform admin and has no `coreUserId` yet;
  otherwise the staff add proceeds and the verified sign-in handoff links later. When `emailVerified`
  is true and Retails has no account for that email, Retails creates one (lowercased email, name from
  the email's local part, no password) so the add can proceed; the person signs in through Studio.
  With `emailVerified` false and no account, nothing is created and the add fails as `USER_NOT_FOUND`.
  Two local accounts that differ only by email case are never linked. Any non-2xx status,
  timeout, or malformed body makes the staff add fail with the retryable `CORE_UNAVAILABLE`
  (nothing is added, no fallback). Retails does not call this for users that already have a
  `coreUserId`.
- Handoff: the `nonce` echo rules above (section "sign-in handoff") apply unchanged.
- Studio must rate-limit `identities`: it creates accounts or invitations for arbitrary emails.
- Error bodies are never read or logged by Retails; only the status code is kept.

## Studio link (Part A)

Environment (see `.env.example`). The three secrets must be at least 16 characters, should differ from
each other, and be set as environment variables only (never committed or logged).

| Variable | Meaning |
| --- | --- |
| `CORE_BASE_URL` | Studio's base URL, no trailing slash. **https is required in production** (a plain-http URL is refused in production). Unset: standalone mode, no Studio button, no key pull. |
| `CORE_SYNC_SECRET` | Verifies Studio -> Retails signed requests (`POST /api/core/v1/provision`, `POST` and `GET /api/core/v1/state`). |
| `CORE_SYNC_SECRET_PREVIOUS` | Optional. The previous sync secret, also accepted during a rotation. |
| `CORE_OUT_SECRET` | Signs Retails -> Studio requests (key pull, identities). Studio holds the same value. |
| `CORE_HANDOFF_SECRET` | Verifies the sign-in handoff token signed by Studio. |
| `CORE_HANDOFF_SECRET_PREVIOUS` | Optional. The previous handoff secret, also accepted during a rotation. |

`APP_URL` must be the public https origin: it builds the callback URL sent to Studio.

**Rotating a secret** (`CORE_SYNC_SECRET` or `CORE_HANDOFF_SECRET`; no downtime):
1. Set `*_PREVIOUS` to the current value and `*` to the new one in Retails; redeploy. Both are accepted.
2. Switch Studio's signer to the new value.
3. After the longest in-flight window (a few minutes for sync, 60 s for a handoff token), clear `*_PREVIOUS`.

`CORE_OUT_SECRET` has no overlap: change it in Studio and Retails together; calls in between fail
(a key pull falls back to the cached key, a staff add fails with the retryable `CORE_UNAVAILABLE`).

**AI key.** A linked deployment (`CORE_BASE_URL` set) never uses `ANTHROPIC_API_KEY`: the key comes
only from Studio, and with none, AI is unavailable. The variable is used only in standalone mode
(`CORE_BASE_URL` unset) and, outside production, as a development fallback; remove it from linked
production deployments.

**Sessions and sign-out.** Logout is one-way and declared as such: signing out of Retails does not
sign out of Studio, and Studio signing out, suspending or removing a user does not end an existing
Retails session. Every session ends at the latest 12 hours after sign-in (no sliding refresh). Local
email and password sign-in stays available for development and emergencies; Studio sign-in is
additional to it.

**Suspend and archive.** A Studio snapshot is state, not an order: SUSPENDED makes the shop read-only,
ARCHIVED closes it, and ARCHIVED is final (a later ACTIVE snapshot does not reopen it). The effect is
not instant: it applies when the snapshot is delivered (push, or reconcile below) and the gate is
read on the next request; a signed-in user keeps reading until then. For a linked shop the admin page
shows "Linked to Studio" and disables the local AI switch; local edits of plan, subscription,
status or the AI switch are overwritten by the next snapshot. The AI-switch lock is a UI guard only
(the sync overwrites the value anyway). There is no local subscription editing in Retails at all:
subscriptions of linked shops change only through Studio snapshots.

Owner invitations are refused for linked shops (`CORE_MANAGED`): the owner arrives through Studio.
Studio plans are stored per shop as `core:<coreBusinessId>:<code>` and are not offered by the local create form.

**Reconcile.** `GET /api/core/v1/state?coreBusinessId=` (signed with the sync secret, empty body)
returns the state Retails holds and its version, for Studio to compare with its own and re-push when
they differ. `GET /api/core/v1/health` is an unauthenticated liveness check by design (it returns only `{"ok":true}`). The handoff token travels in the callback URL's query string, so operators should keep query strings
out of access and proxy logs for `/api/core/v1/handoff/callback`. Snapshots with an older
or equal version are ignored, and one for a shop not provisioned yet is a retryable 404.

**When Studio is down.** Sign-in by handoff fails (the user sees one generic message; local sign-in
still works). Shops keep running on the last snapshot. Keys already pulled are served from memory
(60 s cache, up to 1 h stale while Studio fails, Studio is skipped for 15 s after a failure); after
that, in production, AI reads fail as `AI_UNAVAILABLE` and the quota half unit is refunded. Adding
staff to a linked shop fails with the retryable `CORE_UNAVAILABLE` until Studio answers. Snapshots
that Studio could not deliver are re-sent by Studio or picked up by its reconcile.

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
