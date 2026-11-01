/*
 * Liveness for Studio's sender. No signature, no business data, never cached.
 */

export const dynamic = "force-dynamic";

export function GET(): Response {
  return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}
