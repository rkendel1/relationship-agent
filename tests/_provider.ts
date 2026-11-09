/**
 * TEST DOUBLE of the delivery provider's HTTP contract (POST /messages, GET /messages/{id},
 * GET /health). It exists only to exercise FeltKit's real integration path in tests; it delivers
 * nothing. It is not part of the application.
 */
import { createServer } from "node:http";
import { startServer } from "@feltdb/feltkit/server";
import { createTestApp } from "@feltdb/feltkit/testing";

export type Mode = "accept" | "reject" | "down";

export interface ProviderDouble {
  url: string;
  mode: Mode;
  /** What the provider has accepted, by deliveryId (what verification reads). */
  accepted: Map<string, { to: string; subject: string; body: string }>;
  requests: Array<{ method: string; url: string; idempotencyKey?: string; authorized: boolean; body: Record<string, unknown> | null }>;
  close(): Promise<void>;
}

export async function startProvider(): Promise<ProviderDouble> {
  const double: ProviderDouble = { url: "", mode: "accept", accepted: new Map(), requests: [], close: async () => undefined };
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
    double.requests.push({ method: req.method ?? "", url: req.url ?? "", ...(req.headers["idempotency-key"] ? { idempotencyKey: String(req.headers["idempotency-key"]) } : {}), authorized: req.headers.authorization === "Bearer test-provider-token", body });
    const json = (status: number, value: unknown) => (res.writeHead(status, { "content-type": "application/json" }), res.end(JSON.stringify(value)));
    if (req.url === "/health") return json(200, { ok: true });
    if (req.method === "GET" && req.url?.startsWith("/messages/")) {
      const id = decodeURIComponent(req.url.slice("/messages/".length));
      return double.accepted.has(id) ? json(200, { id, status: "accepted" }) : json(404, { error: "not found" });
    }
    if (req.method === "POST" && req.url === "/messages") {
      if (double.mode === "reject") return json(422, { error: "recipient address rejected" });
      // "down": the provider may have accepted it but answers 503: the outcome is unknown to the caller.
      double.accepted.set(String(body?.deliveryId), { to: String(body?.to), subject: String(body?.subject), body: String(body?.body) });
      if (double.mode === "down") return (res.writeHead(503), res.end("unavailable"));
      return json(200, { id: `msg-${String(body?.deliveryId)}`, status: "accepted" });
    }
    json(404, { error: "no route" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  double.url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  double.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return double;
}

/** A test app served over HTTP, so AppPort capabilities (integrations) are called exactly as a client calls them. */
export async function startServedApp(options: { providerUrl?: string } = {}) {
  const saved = { url: process.env.DELIVERY_PROVIDER_URL, key: process.env.FELTKIT_CREDENTIAL_DELIVERY };
  if (options.providerUrl) {
    process.env.DELIVERY_PROVIDER_URL = options.providerUrl;
    process.env.FELTKIT_CREDENTIAL_DELIVERY = "test-provider-token";
  } else {
    delete process.env.DELIVERY_PROVIDER_URL;
    delete process.env.FELTKIT_CREDENTIAL_DELIVERY;
  }
  const t = await createTestApp();
  const server = await startServer({ runtime: t.runtime, projectDir: process.cwd(), port: 0, frontend: null });
  const base = (server as unknown as { url: string }).url;
  const tokens = new Map<string, string>();
  async function token(who: { id: string; type: "user" | "agent"; roles: string[] }) {
    if (!tokens.has(who.id)) tokens.set(who.id, (await t.runtime.issueSession(who, { kind: "test", via: "test" })).token);
    return tokens.get(who.id)!;
  }
  /** POST /appport, as the app's frontend does. */
  async function invoke(who: { id: string; type: "user" | "agent"; roles: string[] }, capability: string, input: unknown, idempotencyKey?: string) {
    const response = await fetch(`${base}/appport`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${await token(who)}` },
      body: JSON.stringify({ protocol: "appport/1", type: "request", requestId: crypto.randomUUID(), capability: { name: capability, version: 1 }, input, ...(idempotencyKey ? { idempotencyKey } : {}) }),
    });
    return (await response.json()) as { ok: true; output: unknown } | { ok: false; error: { code: string; message: string; details?: Record<string, unknown> } };
  }
  return {
    t,
    invoke,
    async close() {
      await (server as unknown as { close(): Promise<void> }).close();
      await t.close();
      if (saved.url === undefined) delete process.env.DELIVERY_PROVIDER_URL;
      else process.env.DELIVERY_PROVIDER_URL = saved.url;
      if (saved.key === undefined) delete process.env.FELTKIT_CREDENTIAL_DELIVERY;
      else process.env.FELTKIT_CREDENTIAL_DELIVERY = saved.key;
    },
  };
}

export const ADA = { id: "ada", type: "user" as const, roles: ["member", "admin", "external_sender"] };
export const LINUS = { id: "linus", type: "user" as const, roles: ["member"] };
export const BOT = { id: "helper-bot", type: "agent" as const, roles: ["agent"] };
