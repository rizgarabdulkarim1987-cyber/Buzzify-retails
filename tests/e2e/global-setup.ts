import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** Seeds the e2e database in a child process (tsx resolves the app's "@/" imports). */
export default function globalSetup(): void {
  const tsx = fileURLToPath(new URL("../../node_modules/tsx/dist/cli.mjs", import.meta.url));
  const seed = fileURLToPath(new URL("./seed.ts", import.meta.url));
  const result = spawnSync(process.execPath, [tsx, seed], { encoding: "utf8", env: { ...process.env, NODE_ENV: "test" } });
  if (result.status !== 0) throw new Error(`e2e seed failed:\n${result.stdout}\n${result.stderr}`);
}
