import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { platform, arch } from "node:os";
import pg from "pg";
import EmbeddedPostgres from "embedded-postgres";
import { isLocalHost } from "./local-db";

export { isLocalHost };

export const EMBEDDED_PORT = 54329;
export const DATA_DIR = resolve(process.cwd(), ".data", "pg");
export const DATABASES = ["retails_dev", "retails_test"] as const;
const TEST_DATABASE = "retails_test";
const USER = "postgres";
const PASSWORD = "postgres";

function adminUrl(database = "postgres"): string {
  return `postgresql://${USER}:${PASSWORD}@localhost:${EMBEDDED_PORT}/${database}`;
}

/** True when the URL targets the embedded server (and so we may start it). */
export function isEmbeddedUrl(url: string): boolean {
  return isLocalHost(url) && Number(new URL(url).port || 5432) === EMBEDDED_PORT;
}

async function isUp(): Promise<boolean> {
  const client = new pg.Client({ connectionString: adminUrl(), connectionTimeoutMillis: 1500 });
  client.on("error", () => undefined);
  try {
    await client.connect();
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function pgCtlPath(): Promise<string> {
  const os = platform() === "win32" ? "windows" : platform();
  const mod = (await import(/* @vite-ignore */ `@embedded-postgres/${os}-${arch()}`)) as { pg_ctl: string };
  return mod.pg_ctl;
}

async function initIfNeeded(): Promise<void> {
  if (existsSync(join(DATA_DIR, "PG_VERSION"))) return;
  mkdirSync(DATA_DIR, { recursive: true });
  const server = new EmbeddedPostgres({
    databaseDir: DATA_DIR,
    user: USER,
    password: PASSWORD,
    port: EMBEDDED_PORT,
    // Without these, initdb on Windows picks the OS code page (WIN1252), which cannot store Arabic.
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
    onLog: () => undefined,
    onError: console.error,
  });
  await server.initialise();
}

/**
 * Creates missing databases as UTF8. A non-UTF8 database listed in `disposable` (test data) is
 * dropped and recreated; any other one is left alone with a warning.
 */
async function ensureDatabases(databases: readonly string[], disposable: readonly string[]): Promise<void> {
  const client = new pg.Client({ connectionString: adminUrl() });
  await client.connect();
  try {
    for (const name of databases) {
      const found = await client.query<{ encoding: string }>(
        "SELECT pg_encoding_to_char(encoding) AS encoding FROM pg_database WHERE datname = $1",
        [name],
      );
      let encoding: string | undefined = found.rows[0]?.encoding;
      if (encoding !== undefined && encoding !== "UTF8") {
        if (!disposable.includes(name)) {
          console.warn(
            `Database ${name} uses ${encoding} and cannot store Arabic text; run "npm run db:reset" to recreate it as UTF8 (this deletes its data).`,
          );
          continue;
        }
        // Test data is disposable: recreate a test database made before the UTF8 fix.
        await client.query(`DROP DATABASE "${name}" WITH (FORCE)`);
        encoding = undefined;
      }
      if (encoding === undefined) {
        // template0 + C locale: UTF8 works whatever the cluster's own encoding and the OS locale are.
        await client.query(`CREATE DATABASE "${name}" TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'`);
      }
    }
  } finally {
    await client.end();
  }
}

/**
 * Starts the embedded server as a detached background process (idempotent) and makes sure the
 * given databases exist (default: all; the test setup asks only for the test database).
 */
export async function startServer(
  databases: readonly string[] = DATABASES,
  disposable: readonly string[] = [TEST_DATABASE],
): Promise<void> {
  if (!(await isUp())) {
    await initIfNeeded();
    const log = join(DATA_DIR, "server.log");
    const result = spawnSync(
      await pgCtlPath(),
      ["start", "-D", DATA_DIR, "-w", "-t", "60", "-l", log, "-o", `-p ${EMBEDDED_PORT}`],
      { stdio: "ignore", windowsHide: true },
    );
    if (result.status !== 0 || !(await isUp())) {
      throw new Error(`Embedded Postgres failed to start (see ${log})`);
    }
  }
  await ensureDatabases(databases, disposable);
}

export async function stopServer(): Promise<void> {
  if (!existsSync(join(DATA_DIR, "PG_VERSION"))) return;
  spawnSync(await pgCtlPath(), ["stop", "-D", DATA_DIR, "-m", "fast", "-w"], {
    stdio: "ignore",
    windowsHide: true,
  });
}
