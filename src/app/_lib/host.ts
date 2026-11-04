import { headers } from "next/headers";
import { resolveHost, type HostContext } from "@/packs/hosts";

/** The host this request is served on (see src/packs/hosts.ts for what is trusted). */
export async function currentHost(): Promise<HostContext> {
  return resolveHost(await headers());
}
