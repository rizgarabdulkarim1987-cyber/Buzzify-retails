import { readCoreState, syncCoreState } from "@/server/admin/core-state";
import { CoreConfigError } from "@/server/core/config";
import { coreRateLimit } from "@/server/core/rate-limit";
import { verifyRequest } from "@/server/core/signing";
import { coreStateSchema } from "@/server/core/state";

/*
 * State sync with Studio. A Route Handler called server to server with signed requests.
 * POST pushes a snapshot: size cap, raw body text, signature over pathname + query + raw body
 * (401 before anything is parsed or written), rate limit per client address, JSON and zod (400),
 * then apply. A snapshot for a business that was never provisioned is a retryable 404 and creates
 * nothing; an older or equal version is 200 {applied:false}. GET ?coreBusinessId= is the
 * reconciliation read, signed over pathname + query with an empty body. Error bodies carry only a
 * code; nothing here logs a body, a secret or a signature.
 */

export const dynamic = "force-dynamic";

const MAX_BODY_CHARS = 256 * 1024;
const MAX_ID_CHARS = 128;

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });

function clientIp(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return (forwarded || headers.get("x-real-ip")?.trim() || "unknown").slice(0, 64);
}

function failure(tag: string, err: unknown): Response {
  if (err instanceof CoreConfigError) {
    console.error(`[core.${tag}] misconfigured: ${err.variable}`);
    return json({ ok: false, code: "UNAVAILABLE" }, 503);
  }
  console.error(`[core.${tag}] unexpected failure: ${err instanceof Error ? err.name : typeof err}`);
  return json({ ok: false, code: "INTERNAL" }, 503);
}

export async function POST(req: Request): Promise<Response> {
  try {
    const length = Number(req.headers.get("content-length") ?? 0);
    // A malformed header (NaN) is not a size: ignore it and let the text length decide.
    if (Number.isFinite(length) && length > MAX_BODY_CHARS) return json({ ok: false, code: "TOO_LARGE" }, 413);
    const text = await req.text();
    if (text.length > MAX_BODY_CHARS) return json({ ok: false, code: "TOO_LARGE" }, 413);

    const url = new URL(req.url);
    const verified = verifyRequest({ method: req.method, path: url.pathname + url.search, body: text, headers: req.headers });
    if (!verified.ok) return json({ ok: false, code: "UNAUTHORIZED" }, 401);

    if (!(await coreRateLimit("sync", clientIp(req.headers))).ok) return json({ ok: false, code: "RATE_LIMITED" }, 429);

    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return json({ ok: false, code: "INVALID_INPUT" }, 400);
    }
    const parsed = coreStateSchema.safeParse(raw);
    if (!parsed.success) return json({ ok: false, code: "INVALID_INPUT" }, 400);

    const result = await syncCoreState(parsed.data);
    if (!result) return json({ ok: false, code: "NOT_FOUND" }, 404);
    return json(result);
  } catch (err) {
    return failure("state", err);
  }
}

export async function GET(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    // A GET has no body: the signed body is the empty string.
    const verified = verifyRequest({ method: req.method, path: url.pathname + url.search, body: "", headers: req.headers });
    if (!verified.ok) return json({ ok: false, code: "UNAUTHORIZED" }, 401);

    if (!(await coreRateLimit("sync", clientIp(req.headers))).ok) return json({ ok: false, code: "RATE_LIMITED" }, 429);

    const id = url.searchParams.get("coreBusinessId")?.trim() ?? "";
    if (id.length === 0 || id.length > MAX_ID_CHARS) return json({ ok: false, code: "INVALID_INPUT" }, 400);

    const report = await readCoreState(id);
    if (!report) return json({ ok: false, code: "NOT_FOUND" }, 404);
    return json(report);
  } catch (err) {
    return failure("state", err);
  }
}
