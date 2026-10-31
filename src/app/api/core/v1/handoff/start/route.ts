import { clientIp } from "@/server/auth/login-throttle";
import { CoreConfigError } from "@/server/core/config";
import { HANDOFF_FAILURE_PATH, handoffRedirect, startHandoff } from "@/server/core/handoff";
import { coreRateLimit } from "@/server/core/rate-limit";

/*
 * Sign in with Studio, step 1: GET /api/core/v1/handoff/start?returnTo=/internal/path. Rate limited
 * per client address, then a fresh state goes into a short-lived HttpOnly SameSite=Lax cookie
 * (Secure in production) with the validated returnTo, and the browser goes to Studio's
 * /api/retail/v1/handoff with our absolute callback URL (from APP_URL) and the state. Any failure
 * sends the browser to /login?error=core; logs carry the error class or variable name only.
 */

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  try {
    if (!(await coreRateLimit(clientIp(req.headers))).ok) return handoffRedirect(HANDOFF_FAILURE_PATH);
    const returnTo = new URL(req.url).searchParams.get("returnTo");
    const { redirectTo, stateCookie } = startHandoff(returnTo, { secure: process.env.NODE_ENV === "production" });
    return handoffRedirect(redirectTo, [stateCookie]);
  } catch (err) {
    if (err instanceof CoreConfigError) console.error(`[core.handoff.start] misconfigured: ${err.variable}`);
    else console.error(`[core.handoff.start] unexpected failure: ${err instanceof Error ? err.name : typeof err}`);
    return handoffRedirect(HANDOFF_FAILURE_PATH);
  }
}
