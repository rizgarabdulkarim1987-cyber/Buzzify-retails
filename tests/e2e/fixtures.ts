/* Seed data shared by tests/e2e/seed.ts and the e2e specs (test-only values). */
import { fileURLToPath } from "node:url";

export const E2E_PORT = Number(process.env.E2E_PORT || 3100);
export const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ?? "postgresql://postgres:postgres@localhost:54329/retails_e2e";
export const E2E_SECRET = "e2e-secret-e2e-secret-e2e-secret-0123";

export const PASSWORD = "e2e-password-123";

/**
 * Studio-link e2e: the browser handoff (tests/e2e/core-handoff.spec.ts) intercepts the browser's
 * request to Studio; the /login form's server-to-server calls (tests/e2e/login.spec.ts) reach the
 * small fake Studio of tests/e2e/fake-studio.ts on E2E_STUDIO_PORT. The handoff and caller secrets
 * are the dev server's (playwright.config.ts); CORE_SHOP is the Studio-linked shop seeded for both.
 */
export const E2E_STUDIO_PORT = Number(process.env.E2E_STUDIO_PORT || E2E_PORT + 7);
export const E2E_CORE_BASE_URL = `http://127.0.0.1:${E2E_STUDIO_PORT}`;
export const E2E_HANDOFF_SECRET = "e2e-handoff-secret-e2e-handoff-0123";
export const E2E_OUT_SECRET = "e2e-caller-secret-e2e-caller-0123";
/** Fake Studio accounts: the shop's owner signs in with PASSWORD; TWO_STEP also asks for TWO_STEP.code. */
export const TWO_STEP = { email: "two-step@e2e.test", code: "123456" };
export const CORE_SHOP = {
  name: "متجر ستوديو",
  coreBusinessId: "core-biz-e2e",
  owner: { coreUserId: "core-user-e2e", email: "studio-owner@e2e.test", name: "مالك ستوديو" },
};

export const ADMIN = { email: "admin@e2e.test", name: "مدير المنصة" };
export const OWNER = { email: "owner@e2e.test", name: "سارة المالكة" };
export const CASHIER = { email: "cashier@e2e.test", name: "علي الكاشير" };
export const MANAGER = { email: "manager@e2e.test", name: "منى المديرة" };
export const LONG_OWNER = { email: "long@e2e.test", name: "Hawre Ahmed" };

export const BUSINESS = "سوق النخيل";
export const BRANCH_A = "فرع المنصور";
export const BRANCH_B = "فرع الكرادة";
export const TERMINAL_A = "كاشير ١";

/** Exactly 80 characters, Arabic with Arabic-Indic digits, no edge spaces. */
export const LONG_BUSINESS = "مجموعة أسواق الرافدين الكبرى للمواد الغذائية والمنزلية والإلكترونيات ٢٠٢٦ بغداد ".repeat(2).slice(0, 79) + "ع";
export const LONG_BRANCH = "فرع شارع فلسطين قرب ساحة بيروت مقابل المجمع التجاري الكبير";

/** Catalog rows seeded for the business (tests/e2e/catalog.spec.ts). */
export const SUGAR = { nameAr: "سكر ناعم ١ كغم", barcode: "6281000000017", priceIqd: "1250" };
/** Exactly 120 characters, Arabic, no edge spaces. */
export const LONG_PRODUCT_NAME = (
  "علبة حليب مجفف كامل الدسم مدعمة بالفيتامينات والمعادن مناسبة للأطفال والكبار تحفظ في مكان بارد وجاف بعيدا عن أشعة الشمس المباشرة والرطوبة العالية جدا "
).repeat(2).slice(0, 119) + "ا";
export const LONG_PRODUCT_BARCODE = "6281000000024";

/** A stock item seeded for tests/e2e/stock.spec.ts: batches with expiry dates, a piece and a carton of 12. */
export const STOCK_ITEM = { nameAr: "حليب طويل الأجل ١ لتر", barcode: "6281000000031", piece: "علبة", carton: "كرتون", cartonFactor: 12 };

/**
 * R1b (tests/e2e/intake.spec.ts): an item known by a valid EAN-13 (the seeded SUGAR/STOCK_ITEM codes
 * fail the retail checksum), sold by the piece, not batch-tracked, so a receipt draft posts as read.
 */
export const INTAKE_ITEM = { nameAr: "طحين صفر ١ كغم", barcode: "6291041500213", piece: "قطعة" };
/** tests/e2e/sell-usd.spec.ts: a plain item (not batch-tracked) in stock at branch A, priced 29,250 dinars. */
export const USD_ITEM = { nameAr: "زيت طبخ ٣ لتر", barcode: "6281000000048", priceIqd: "29250" };
/** The seeded plan's monthly AI reads (the shop's quota is twice this in half units). */
export const AI_MONTHLY = 20;
/** The fake provider's scenario file for the e2e dev server (INTAKE_PROVIDER=fake reads it on every call). */
export const INTAKE_FAKE_FILE = fileURLToPath(new URL("./intake-receipt.json", import.meta.url));
