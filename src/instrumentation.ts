/*
 * Runs once when a server instance starts. In production a malformed PACK_HOSTS stops the start
 * (the error names the variable and the rule, never a secret); unset means one shared address.
 * Outside production the same check runs at the first request that needs it.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.NODE_ENV !== "production") return;
  const { assertPackHosts } = await import("./packs/hosts");
  assertPackHosts();
}
