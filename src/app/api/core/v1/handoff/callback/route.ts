import { completeHandoff } from "@/server/admin/core-handoff";
import { clientIp } from "@/server/auth/login-throttle";
import { CoreConfigError } from "@/server/core/config";
import { HANDOFF_FAILURE_PATH, HANDOFF_STATE_COOKIE, clearStateCookie, handoffRedirect } from "@/server/core/handoff";
import { coreRateLimit } from "@/server/core/rate-limit";

/*
 * Sign in with Studio, step 2: Studio sends the browser back to
 * GET /api/core/v1/handoff/callback?token=&state=. Rate limited per client address. The state
 * cookie is cleared on every answer. completeHandoff checks the state, the token and its jti,
 * links or creates the local user and opens a 12 h Better Auth session; the browser then goes to
 * the stored returnTo. Any failure goes to /login?error=core with no detail; nothing logs the
 * token, the state or a secret (only the failure reason or the error class).
 */

export const dynamic = "force-dynamic";

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

export async function GET(req: Request): Promise<Response> {
  const clear = clearStateCookie(process.env.NODE_ENV === "production");
  try {
    const ip = clientIp(req.headers);
    if (!(await coreRateLimit("handoff", ip)).ok) return handoffRedirect(HANDOFF_FAILURE_PATH, [clear]);

    const query = new URL(req.url).searchParams;
    const outcome = await completeHandoff({
      token: query.get("token"),
      state: query.get("state"),
      stateCookie: readCookie(req.headers.get("cookie"), HANDOFF_STATE_COOKIE),
      ipAddress: ip === "unknown" ? "" : ip,
      userAgent: req.headers.get("user-agent") ?? "",
    });
    if (!outcome.ok) {
      console.warn(`[core.handoff.callback] refused: ${outcome.reason}`);
      return handoffRedirect(HANDOFF_FAILURE_PATH, [clear]);
    }
    return handoffRedirect(outcome.returnTo, [clear, outcome.setCookie]);
  } catch (err) {
    if (err instanceof CoreConfigError) console.error(`[core.handoff.callback] misconfigured: ${err.variable}`);
    else console.error(`[core.handoff.callback] unexpected failure: ${err instanceof Error ? err.name : typeof err}`);
    return handoffRedirect(HANDOFF_FAILURE_PATH, [clear]);
  }
}
