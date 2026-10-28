import { defineConfig, devices } from "@playwright/test";
import { E2E_DATABASE_URL, E2E_PORT, E2E_SECRET } from "./tests/e2e/fixtures";

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
    },
  },
});
