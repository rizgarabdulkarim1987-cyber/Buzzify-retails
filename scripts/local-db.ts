/*
 * Which database URLs the developer tooling may touch. Kept free of dependencies so
 * prisma.config.ts can import it without loading the embedded server.
 */

const LOCAL_HOSTS = ["localhost", "127.0.0.1", "::1", "[::1]"];

/** True when the URL's host is this machine. */
export function isLocalHost(url: string): boolean {
  return LOCAL_HOSTS.includes(new URL(url).hostname);
}

/** The env flag that allows a non-local database (deployments only, never a developer machine by accident). */
export const ALLOW_REMOTE_ENV = "ALLOW_REMOTE_DATABASE";

/**
 * Returns `url` when it is local, or when `env.ALLOW_REMOTE_DATABASE === "1"`; otherwise throws.
 * `undefined` passes through (the caller supplies its own local default). `what` names the variable in the error.
 */
export function guardDatabaseUrl(
  url: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
  what = "DATABASE_URL",
): string | undefined {
  if (url === undefined || url === "") return undefined;
  let local: boolean;
  try {
    local = isLocalHost(url);
  } catch {
    throw new Error(`${what} is not a valid URL`);
  }
  if (local || env[ALLOW_REMOTE_ENV] === "1") return url;
  throw new Error(
    `Refusing ${what} with non-local host "${new URL(url).hostname}". Set ${ALLOW_REMOTE_ENV}=1 to target a remote database on purpose.`,
  );
}
