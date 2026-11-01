# Going live on Hostinger (Retails)

Retails is its own Node.js app with its own database and its own domain. It is linked to Studio
(`https://studio.buzzify-menu.online`), which holds the identities, the plans, the Super Admin and the
Anthropic key. This page is the checklist for the first deploy. Nothing here has been done yet. The
Studio side is in the Studio repo, `docs/deploy/hostinger.md`, section "Buzzify Retail link".

Rule: no `prisma migrate deploy` against production without the owner's approval. A new empty Retails
database has nothing to lose, so its first `migrate deploy` is low risk; Studio's is not (take a fresh
backup first, its `ALTER TYPE ... ADD VALUE 'RETAIL'` cannot be undone).

## 1. Before you start

- A PostgreSQL 15+ database for Retails alone. Never Studio's database. The stock tables use
  `NULLS NOT DISTINCT` unique keys; CI runs on 17.
- A domain for Retails, for example `https://retail.buzzify-menu.online`. It is written the same way
  on both sides: `https://`, lowercase, no path, no trailing slash, no port.
- Three secrets, all different, each at least 16 characters:

```bash
openssl rand -base64 32
```

## 2. Environment variables (Hostinger -> Websites -> Node.js -> Environment variables)

| Retails | Studio | Value |
| --- | --- | --- |
| `DATABASE_URL` | | the Retails database |
| `BETTER_AUTH_SECRET` | | 32+ random characters, Retails only |
| `APP_URL` | `RETAIL_URL` | the Retails address, identical on both sides |
| `CORE_BASE_URL` | | `https://studio.buzzify-menu.online`. Not `buzzify-menu.online`: there `/api/retail/...` is a 404, which Retails reads as "no AI key" |
| `CORE_SYNC_SECRET` | `RETAIL_SYNC_SECRET` | secret 1 (signs provision and state calls) |
| `CORE_OUT_SECRET` | `RETAIL_CALLER_SECRET` | secret 2 (signs Retails' calls to Studio) |
| `CORE_HANDOFF_SECRET` | `RETAIL_HANDOFF_SECRET` | secret 3 (signs sign-in tokens) |

Leave these unset in production:

- `ANTHROPIC_API_KEY`: Retails pulls the key from Studio. Setting it is only a fallback outside production.
- `INTAKE_PROVIDER`: `fake` is for tests; in production it makes every AI read fail closed.

`INTAKE_MODEL` (default `claude-sonnet-5-5`) and `INTAKE_TIMEOUT_MS` (default 60000) can stay as they are.
Environment variables only: never commit or log a secret. To rotate one, move the old value to the
matching `*_PREVIOUS` variable and set the new one.

## 3. Deploy the app

1. Create the Node.js site on the new domain from the repository `Buzzify-retails`, branch `main`.
2. Build `npm run build`, start `npm run start`. `postinstall` runs `prisma generate`.
3. Set the variables of section 2 before the first build.
4. Apply the migrations to the new empty database (with the owner's approval):

```bash
npx prisma migrate deploy
```

   `prisma.config.ts` does not read a `.env` file, so `DATABASE_URL` must be in the shell environment.
5. Open the domain: it must answer over https.

## 4. Switch on the link (Studio side)

Do these only after Retails is up, in this order:

1. Studio: fresh backup, then deploy Studio's new `main`, then its `prisma migrate deploy`.
2. Studio: set `RETAIL_URL` and the three `RETAIL_*` secrets (same values as above), redeploy.
3. Studio cron jobs (hPanel -> Advanced -> Cron Jobs), with Studio's `CRON_SECRET`:
   `/api/cron/retail-sync` every minute (not more often; Retails allows 120 calls a minute from Studio),
   `/api/cron/retail-reconcile` every hour. Do not add a second retail-sync job.
4. Studio billing screens: create the retail plans and their prices (each plan must allow at least as
   many branches as the shops on it), then turn the `retail` product on. It starts off.
5. Create a test retail business, start its trial, let its owner accept the invitation, and sign in to
   Retails from Studio.

## 5. Checks after the deploy

- Owner and staff reach Retails from Studio with one sign-in and the same email.
- Suspend and activate a shop in Studio: Retails follows within a minute.
- A receipt read with the `ai.intake` switch on (a Super Admin sets it per shop, with a reason; no row
  means off) and the owner's consent. This has only been tested with a fake provider and has never been
  tried with a real Claude call: do it once on a test shop before real shops use it.
- Retails keeps working with Studio down: it serves the last AI key for at most 1 hour, then AI reads
  fail as `AI_UNAVAILABLE`, and nothing else stops.

## 6. Notes

- Sign-in tokens pass in the query string of `/api/retail/v1/handoff` on the Studio side and in the
  handoff URL on this side. Do not keep access logs of those paths longer than needed.
- If Studio's database is restored from a backup, press Resync on each retail shop.
- More detail (the Studio contract, retention of receipt images, migrations by milestone) is in
  `docs/deployment-notes.md`.
