import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  // useTestDb is a Vitest setup helper, not a React hook.
  { files: ["tests/**"], rules: { "react-hooks/rules-of-hooks": "off" } },
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts", ".data/**", "node_modules/**", "src/generated/**"]),
]);
