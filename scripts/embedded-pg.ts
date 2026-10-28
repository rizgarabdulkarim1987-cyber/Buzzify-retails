import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { platform, arch } from "node:os";
import pg from "pg";
import EmbeddedPostgres from "embedded-postgres";

export const EMBEDDED_PORT = 54329;
export const DATA_DIR = resolve(process.cwd(), ".data", "pg");
export const DATABASES = ["retails_dev", "retails_test"] as const;
const LOCAL_HOSTS = ["localhost", "127.0.0.1", "::1", "[::1]"];
const USER = "postgres";
const PASSWORD = "postgres";

function adminUrl(database = "postgres"): string {
  return `postgresql://${USER}:${PASSWORD}@localhost:${EMBEDDED_PORT}/${database}`;
}

export function isLocalHost(url: string): boolean {
  return LOCAL_HOSTS.includes(new URL(url).hostname);
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
    onLog: () => undefined,
    onError: console.error,
  });
  await server.initialise();
}

async function ensureDatabases(): Promise<void> {
  const client = new pg.Client({ connectionString: adminUrl() });
  await client.connect();
  try {
    for (const name of DATABASES) {
      const found = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
      if (found.rowCount === 0) await client.query(`CREATE DATABASE "${name}"`);
    }
  } finally {
    await client.end();
  }
}

/** Starts the embedded server as a detached background process (idempotent). */
export async function startServer(): Promise<void> {
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
  await ensureDatabases();
}

export async function stopServer(): Promise<void> {
  if (!existsSync(join(DATA_DIR, "PG_VERSION"))) return;
  spawnSync(await pgCtlPath(), ["stop", "-D", DATA_DIR, "-m", "fast", "-w"], {
    stdio: "ignore",
    windowsHide: true,
  });
}
