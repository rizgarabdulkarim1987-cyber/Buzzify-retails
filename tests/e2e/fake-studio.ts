import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import http from "node:http";
import { signHandoffForTests } from "../../src/server/core/handoff";
import { CORE_SHOP, E2E_HANDOFF_SECRET, E2E_OUT_SECRET, E2E_STUDIO_PORT, PASSWORD, TWO_STEP } from "./fixtures";

/*
 * A stand-in for Studio's /api/retail/v1/credentials* (test-only values), for the e2e dev server's
 * /login form. It checks the signature like Studio does (METHOD, path, timestamp, sha256(body),
 * HMAC with the caller secret, +-120 s) and answers like Studio: the seeded Studio-linked shop's
 * owner signs in with PASSWORD; TWO_STEP also asks for its code. Tokens are signed with the dev
 * server's handoff secret and carry the nonce Retails sent. Every other path answers 503.
 */

const sha256Hex = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const mac = (path: string, timestamp: string, body: string) =>
  createHmac("sha256", E2E_OUT_SECRET).update(`POST\n${path}\n${timestamp}\n${sha256Hex(body)}`, "utf8").digest("hex");

function signed(path: string, headers: http.IncomingHttpHeaders, body: string): boolean {
  const ts = String(headers["x-bz-timestamp"] ?? "");
  const sig = String(headers["x-bz-signature"] ?? "");
  if (!/^\d{1,12}$/.test(ts) || !/^[0-9a-f]{64}$/.test(sig) || Math.abs(Date.now() / 1000 - Number(ts)) > 120) return false;
  return timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(mac(path, ts, body), "hex"));
}

function token(nonce: string): string {
  const iat = Math.floor(Date.now() / 1000);
  return signHandoffForTests(
    {
      aud: "retail",
      iat,
      exp: iat + 60,
      nonce,
      jti: randomUUID(),
      coreUserId: CORE_SHOP.owner.coreUserId,
      email: CORE_SHOP.owner.email,
      emailVerified: true,
      name: CORE_SHOP.owner.name,
      coreBusinessId: CORE_SHOP.coreBusinessId,
    },
    E2E_HANDOFF_SECRET,
  );
}

const CHALLENGE = "tf.e2e-two-step-challenge";

function answer(path: string, input: Record<string, string>): unknown {
  if (path === "/api/retail/v1/credentials") {
    const email = String(input.email ?? "").trim().toLowerCase();
    if (input.password !== PASSWORD) return { status: "invalid" };
    if (email === CORE_SHOP.owner.email) return { status: "ok", handoffToken: token(input.nonce!) };
    if (email === TWO_STEP.email) return { status: "needs_2fa", challenge: CHALLENGE };
    return { status: "invalid" };
  }
  if (path === "/api/retail/v1/credentials/two-factor") {
    if (input.challenge !== CHALLENGE) return { status: "expired" };
    return String(input.code ?? "").trim() === TWO_STEP.code ? { status: "ok", handoffToken: token(input.nonce!) } : { status: "invalid_code" };
  }
  return null;
}

const server = http.createServer((req, res) => {
  const path = (req.url ?? "/").split("?")[0]!;
  if (req.method === "GET" && path === "/health") {
    res.writeHead(200).end("ok");
    return;
  }
  let body = "";
  req.setEncoding("utf8");
  req.on("data", (chunk: string) => (body += chunk));
  req.on("end", () => {
    const json = (status: number, value: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
    if (req.method !== "POST" || !path.startsWith("/api/retail/v1/credentials")) return json(503, { code: "UNAVAILABLE" });
    if (!signed(path, req.headers, body)) return json(401, { code: "UNAUTHORIZED" });
    let input: Record<string, string>;
    try {
      input = JSON.parse(body) as Record<string, string>;
    } catch {
      return json(400, { code: "INVALID_INPUT" });
    }
    const out = answer(path, input);
    return out ? json(200, out) : json(404, { code: "NOT_FOUND" });
  });
});

server.listen(E2E_STUDIO_PORT, "127.0.0.1");
