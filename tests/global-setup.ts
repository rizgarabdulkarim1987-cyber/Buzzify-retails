import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { isEmbeddedUrl, isLocalHost, startServer } from "../scripts/embedded-pg";

const prismaCli = fileURLToPath(new URL("../node_modules/prisma/build/index.js", import.meta.url));
const LOCAL_TEST_DATABASE_URL = "postgresql://postgres:postgres@localhost:54329/retails_test";

export default async function setup(): Promise<void> {
  const url = (process.env.TEST_DATABASE_URL ??= LOCAL_TEST_DATABASE_URL);
  if (!isLocalHost(url)) {
    throw new Error(`Refusing to run tests against non-local database host "${new URL(url).hostname}"`);
  }
  // Only the embedded server is ours to start; in CI the URL points at a service container.
  // Only the test database: it is disposable, so one created before the UTF8 fix is recreated.
  if (isEmbeddedUrl(url)) {
    const name = decodeURIComponent(new URL(url).pathname.slice(1));
    await startServer([name], [name]);
  }

  const migrate = spawnSync(process.execPath, [prismaCli, "migrate", "deploy"], {
    env: { ...process.env, DATABASE_URL: url },
    encoding: "utf8",
  });
  if (migrate.status !== 0) {
    throw new Error(`prisma migrate deploy failed:\n${migrate.stdout}\n${migrate.stderr}`);
  }
}
