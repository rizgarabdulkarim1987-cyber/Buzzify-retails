/* Seed data shared by tests/e2e/seed.ts and the e2e specs (test-only values). */

export const E2E_PORT = 3100;
export const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ?? "postgresql://postgres:postgres@localhost:54329/retails_e2e";
export const E2E_SECRET = "e2e-secret-e2e-secret-e2e-secret-0123";

export const PASSWORD = "e2e-password-123";

export const ADMIN = { email: "admin@e2e.test", name: "مدير المنصة" };
export const OWNER = { email: "owner@e2e.test", name: "سارة المالكة" };
export const CASHIER = { email: "cashier@e2e.test", name: "علي الكاشير" };
export const LONG_OWNER = { email: "long@e2e.test", name: "Hawre Ahmed" };

export const BUSINESS = "سوق النخيل";
export const BRANCH_A = "فرع المنصور";
export const BRANCH_B = "فرع الكرادة";
export const TERMINAL_A = "كاشير ١";

/** Exactly 80 characters, Arabic with Arabic-Indic digits, no edge spaces. */
export const LONG_BUSINESS = "مجموعة أسواق الرافدين الكبرى للمواد الغذائية والمنزلية والإلكترونيات ٢٠٢٦ بغداد ".repeat(2).slice(0, 79) + "ع";
export const LONG_BRANCH = "فرع شارع فلسطين قرب ساحة بيروت مقابل المجمع التجاري الكبير";
