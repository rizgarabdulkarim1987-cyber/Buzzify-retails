/*
 * Seeds the e2e database through the app's own server code (Better Auth sign-up, the platform
 * provisioning action, the owner invitation acceptance, the setup wizard's staff step). Rows that
 * have no action yet (terminals: a later task) are inserted with the base client, as the vitest fixtures do.
 *
 * Run with DATABASE_URL pointing at the e2e database: `tsx tests/e2e/seed.ts` (global-setup does).
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isEmbeddedUrl, isLocalHost, startServer } from "../../scripts/embedded-pg";
import {
  ADMIN,
  AI_MONTHLY,
  BRANCH_A,
  BRANCH_B,
  BUSINESS,
  CASHIER,
  E2E_DATABASE_URL,
  LONG_BRANCH,
  LONG_BUSINESS,
  LONG_OWNER,
  LONG_PRODUCT_BARCODE,
  LONG_PRODUCT_NAME,
  MANAGER,
  OWNER,
  PASSWORD,
  STOCK_ITEM,
  SUGAR,
  TERMINAL_A,
  E2E_SECRET,
  INTAKE_ITEM,
} from "./fixtures";

const url = E2E_DATABASE_URL;
if (!isLocalHost(url)) throw new Error(`Refusing to seed non-local database host "${new URL(url).hostname}"`);
process.env.DATABASE_URL = url;
process.env.BETTER_AUTH_SECRET ??= E2E_SECRET;
process.env.APP_URL ??= "http://localhost:3100";

async function main() {
  if (isEmbeddedUrl(url)) {
    const name = decodeURIComponent(new URL(url).pathname.slice(1));
    await startServer([name], [name]);
  }
  const prismaCli = fileURLToPath(new URL("../../node_modules/prisma/build/index.js", import.meta.url));
  const migrate = spawnSync(process.execPath, [prismaCli, "migrate", "deploy"], {
    env: { ...process.env, DATABASE_URL: url },
    encoding: "utf8",
  });
  if (migrate.status !== 0) throw new Error(`prisma migrate deploy failed:\n${migrate.stdout}\n${migrate.stderr}`);

  // Imported after DATABASE_URL is set: the singleton client reads it on import.
  const { db } = await import("@/server/db");
  const { auth } = await import("@/server/auth/auth");
  const { provisionBusiness } = await import("@/server/admin/provision");
  const { acceptInvitation } = await import("@/server/admin/invitations");
  const { completeSetupStep } = await import("@/server/setup/progress");
  const { MemoryMailer, setMailer } = await import("@/server/email/mailer");
  setMailer(new MemoryMailer());

  const tables = await db.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  await db.$executeRawUnsafe(`TRUNCATE TABLE ${tables.map((t) => `"public"."${t.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`);

  const signUp = async (u: { email: string; name: string }) =>
    (await auth.api.signUpEmail({ body: { email: u.email, name: u.name, password: PASSWORD } })).user.id;

  const adminId = await signUp(ADMIN);
  await db.rtPlatformAdmin.create({ data: { userId: adminId } });
  await db.rtPlan.create({
    data: { code: "basic", name: "Basic", maxBranches: 5, maxTerminals: 10, maxUsers: 20, storageMb: 1024, aiMonthly: AI_MONTHLY },
  });

  let n = 0;
  async function provision(name: string, branches: string[], ownerEmail: string, ownerId: string) {
    const created = await provisionBusiness(
      {
        name,
        activityType: "MARKET",
        capabilities: [],
        branches: branches.map((b) => ({ name: b })),
        ownerEmail,
        currencies: ["IQD", "USD"],
        planCode: "basic",
        trialDays: 30,
      },
      { userId: adminId, idempotencyKey: `e2e-seed-${++n}` },
    );
    if (!created.ok || !created.value.token) throw new Error(`provision failed: ${JSON.stringify(created)}`);
    const accepted = await acceptInvitation({ token: created.value.token }, { userId: ownerId, idempotencyKey: `e2e-accept-${n}` });
    if (!accepted.ok) throw new Error(`accept failed: ${JSON.stringify(accepted)}`);
    return created.value.businessId;
  }

  const ownerId = await signUp(OWNER);
  const businessId = await provision(BUSINESS, [BRANCH_A, BRANCH_B], OWNER.email, ownerId);
  const longOwnerId = await signUp(LONG_OWNER);
  await provision(LONG_BUSINESS, [LONG_BRANCH], LONG_OWNER.email, longOwnerId);

  // A cashier of branch A, added by the owner through the setup wizard (step 5).
  const branchA = await db.rtBranch.findFirstOrThrow({ where: { businessId, name: BRANCH_A } });
  await signUp(CASHIER);
  const added = await completeSetupStep(
    { step: 5, data: { staff: [{ email: CASHIER.email, role: "CASHIER", branchIds: [branchA.id] }] } },
    { userId: ownerId, businessId, idempotencyKey: "e2e-seed-cashier" },
  );
  if (!added.ok) throw new Error(`adding the cashier failed: ${JSON.stringify(added)}`);
  // A manager of branch A (can manage the catalog and change prices).
  await signUp(MANAGER);
  const addedManager = await completeSetupStep(
    { step: 5, data: { staff: [{ email: MANAGER.email, role: "MANAGER", branchIds: [branchA.id] }] } },
    { userId: ownerId, businessId, idempotencyKey: "e2e-seed-manager" },
  );
  if (!addedManager.ok) throw new Error(`adding the manager failed: ${JSON.stringify(addedManager)}`);
  // One terminal in branch A (no action for terminals until a later task).
  const location = await db.rtLocation.findFirstOrThrow({ where: { businessId, branchId: branchA.id } });
  await db.rtTerminal.create({ data: { businessId, branchId: branchA.id, locationId: location.id, name: TERMINAL_A } });

  // Catalog products for the catalog and stock screens (created through the real action, as the owner).
  const { createProduct } = await import("@/server/catalog/products");
  const seedProduct = async (input: Record<string, unknown>, k: string) => {
    const made = await createProduct(input, { userId: ownerId, businessId, idempotencyKey: k });
    if (!made.ok) throw new Error(`seeding a product failed: ${JSON.stringify(made)}`);
  };
  await seedProduct(
    {
      nameAr: SUGAR.nameAr,
      trackingMode: "BATCH",
      tracksExpiry: true,
      expiryAlertDays: 30,
      baseUnit: { name: "قطعة", barcodes: [SUGAR.barcode] },
      price: { currency: "IQD", amountMinor: SUGAR.priceIqd },
    },
    "e2e-seed-sugar",
  );
  await seedProduct(
    {
      nameAr: LONG_PRODUCT_NAME,
      baseUnit: { name: "قطعة", barcodes: [LONG_PRODUCT_BARCODE] },
      price: { currency: "IQD", amountMinor: "3500" },
    },
    "e2e-seed-long",
  );
  await seedProduct(
    {
      nameAr: STOCK_ITEM.nameAr,
      trackingMode: "BATCH",
      tracksExpiry: true,
      expiryAlertDays: 30,
      baseUnit: { name: STOCK_ITEM.piece, barcodes: [STOCK_ITEM.barcode] },
      extraUnits: [{ name: STOCK_ITEM.carton, factor: STOCK_ITEM.cartonFactor, barcodes: [] }],
      price: { currency: "IQD", amountMinor: "1500" },
    },
    "e2e-seed-stock-item",
  );
  await seedProduct(
    {
      nameAr: INTAKE_ITEM.nameAr,
      baseUnit: { name: INTAKE_ITEM.piece, barcodes: [INTAKE_ITEM.barcode] },
      price: { currency: "IQD", amountMinor: "2000" },
    },
    "e2e-seed-intake-item",
  );

  await db.$disconnect();
  console.log("e2e seed ready");
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
