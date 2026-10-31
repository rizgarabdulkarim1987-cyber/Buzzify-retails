import { coreProvisionInput, provisionFromCore } from "@/server/admin/core-provision";
import { CoreConfigError } from "@/server/core/config";
import { coreRateLimit } from "@/server/core/rate-limit";
import { verifyRequest } from "@/server/core/signing";
import { RuleError } from "@/server/framework/errors";

/*
 * Studio asks Retails to provision a linked business. A Route Handler (not a Server Action): it is
 * called server to server with a signed request. Order: size cap, raw body text, signature over
 * pathname + query + raw body (401 before anything is parsed or written), rate limit per client
 * address, then JSON and zod validation (400), then provisioning (422 for a rule such as the
 * plan's branch limit). Nothing here logs the body, a secret or a signature; unexpected failures
 * log their class only.
 */

export const dynamic = "force-dynamic";

const MAX_BODY_CHARS = 256 * 1024;

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });

function clientIp(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return (forwarded || headers.get("x-real-ip")?.trim() || "unknown").slice(0, 64);
}

export async function POST(req: Request): Promise<Response> {
  try {
    const length = Number(req.headers.get("content-length") ?? 0);
    if (length > MAX_BODY_CHARS) return json({ ok: false, code: "TOO_LARGE" }, 413);
    const text = await req.text();
    if (text.length > MAX_BODY_CHARS) return json({ ok: false, code: "TOO_LARGE" }, 413);

    const url = new URL(req.url);
    const verified = verifyRequest({ method: req.method, path: url.pathname + url.search, body: text, headers: req.headers });
    if (!verified.ok) return json({ ok: false, code: "UNAUTHORIZED" }, 401);

    if (!(await coreRateLimit(clientIp(req.headers))).ok) return json({ ok: false, code: "RATE_LIMITED" }, 429);

    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return json({ ok: false, code: "INVALID_INPUT" }, 400);
    }
    const parsed = coreProvisionInput.safeParse(raw);
    if (!parsed.success) return json({ ok: false, code: "INVALID_INPUT" }, 400);

    const { businessId } = await provisionFromCore(parsed.data);
    return json({ businessId });
  } catch (err) {
    if (err instanceof RuleError) return json({ ok: false, code: err.code }, 422);
    if (err instanceof CoreConfigError) {
      console.error(`[core.provision] misconfigured: ${err.variable}`);
      return json({ ok: false, code: "UNAVAILABLE" }, 503);
    }
    console.error(`[core.provision] unexpected failure: ${err instanceof Error ? err.name : typeof err}`);
    return json({ ok: false, code: "INTERNAL" }, 503);
  }
}
