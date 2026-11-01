import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    // The app's singleton client (src/server/db.ts) reads DATABASE_URL; in tests it must be the test DB.
    env: {
      DATABASE_URL:
        process.env.TEST_DATABASE_URL ?? "postgresql://postgres:postgres@localhost:54329/retails_test",
      BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-123",
      APP_URL: "http://localhost:3000",
    },
    globalSetup: ["tests/global-setup.ts"],
    fileParallelism: false,
    include: ["tests/**/*.test.ts"],
  },
});
