import { defineConfig, devices } from "@playwright/test";
import { E2E_CORE_BASE_URL, E2E_DATABASE_URL, E2E_HANDOFF_SECRET, E2E_PORT, E2E_SECRET, INTAKE_FAKE_FILE } from "./tests/e2e/fixtures";

const baseURL = `http://localhost:${E2E_PORT}`;

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: "**/*.spec.ts",
  globalSetup: "./tests/e2e/global-setup.ts",
  // One seeded database shared by every test: run them one at a time.
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  reporter: [["list"]],
  use: { baseURL, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // A dev server of its own (port and build folder), so it never collides with `npm run dev`.
    command: `node node_modules/next/dist/bin/next dev --port ${E2E_PORT}`,
    url: `${baseURL}/login`,
    reuseExistingServer: false,
    timeout: 240_000,
    env: {
      DATABASE_URL: E2E_DATABASE_URL,
      BETTER_AUTH_SECRET: E2E_SECRET,
      APP_URL: baseURL,
      NEXT_DIST_DIR: ".next-e2e",
      NEXT_TELEMETRY_DISABLED: "1",
      // The AI intake reads with the fake provider, its answer from a fixed file (tests/e2e/intake.spec.ts).
      // `next dev` runs as development; getIntakeProvider never selects the fake in production.
      INTAKE_PROVIDER: "fake",
      INTAKE_FAKE_FILE,
      ANTHROPIC_API_KEY: "",
      // Shows "Sign in with Studio" on /login (tests/e2e/login.spec.ts); nothing listens there.
      CORE_BASE_URL: E2E_CORE_BASE_URL,
      // Verifies the hand-signed handoff token of tests/e2e/core-handoff.spec.ts (test-only value).
      CORE_HANDOFF_SECRET: E2E_HANDOFF_SECRET,
    },
  },
});
