import { appUrl, packOrigin } from "./hosts";
import { getPack } from "./index";

/**
 * The origin to build a shop's absolute URLs on (invitation links, ...): its product's own address
 * when PACK_HOSTS has one, else APP_URL (the shared address, which serves every product). Null when
 * APP_URL is missing too. No trailing slash.
 */
export function shopOrigin(activityType: string | null | undefined): string | null {
  return packOrigin(getPack(activityType).id) ?? appUrl()?.origin ?? null;
}
