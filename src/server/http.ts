import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";
import { log } from "../logger.js";
import { createService } from "../bootstrap.js";
import { verifyXaiWebhook } from "../providers/xai/webhook.js";
import type { PhoneService } from "../service.js";
import type { XaiProvider } from "../providers/xai/index.js";
import type { MakeCallRequest } from "../types.js";

/**
 * HTTP API (provider-independent) + provider webhooks.
 *   POST /calls                      phone.make_call
 *   GET  /calls                      list
 *   GET  /calls/:id/status           phone.get_status   (:id = task_id or call_id)
 *   GET  /calls/:id/result           phone.get_result
 *   POST /calls/:id/cancel           phone.cancel_call
 *   POST /calls/:id/answer           needs_user answer {question_id, answer}
 *   POST /webhooks/xai               realtime.call.incoming (signed)
 *   POST /webhooks/twilio/status     Twilio status callback
 *   POST /webhooks/twilio/amd        Twilio async AMD callback
 *   GET  /healthz
 */
export function createHttpServer(service: PhoneService, xai: XaiProvider | null) {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const t0 = Date.now();
    try {
      const raw = await readBody(req);
      const path = url.pathname;
      if (path === "/healthz") return json(res, 200, { ok: true, default_provider: config.provider, providers: service.providerNames });

      if (path.startsWith("/webhooks/")) return await handleWebhook(path, req, raw, xai, res);

      if (config.serviceToken && req.headers.authorization !== `Bearer ${config.serviceToken}`) return json(res, 401, { error: "unauthorized" });

      const m = path.match(/^\/calls(?:\/([^/]+)(?:\/(status|result|cancel|answer))?)?$/);
      if (!m) return json(res, 404, { error: "not found" });
      const [, id, action] = m;
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      const ref = id ? (id.startsWith("task_") ? { task_id: id } : { call_id: id }) : {};

      if (!id && req.method === "POST") return json(res, 202, await service.makeCall(body as unknown as MakeCallRequest));
      if (!id && req.method === "GET") return json(res, 200, service.listCalls());
      if (action === "status") return json(res, 200, await service.getStatus(ref));
      if (action === "result") return json(res, 200, await service.getResult(ref));
      if (action === "cancel" && req.method === "POST") return json(res, 200, await service.cancelCall(ref));
      if (action === "answer" && req.method === "POST") return json(res, 200, await service.answerQuestion(ref, String(body.question_id ?? ""), String(body.answer ?? "")));
      return json(res, 404, { error: "not found" });
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      log.warn("http.error", { path: url.pathname, error: msg });
      return json(res, msg.startsWith("unknown task") ? 404 : 400, { error: msg });
    } finally {
      log.debug("http.request", { method: req.method, path: url.pathname, ms: Date.now() - t0 });
    }
  });
}

async function handleWebhook(path: string, req: IncomingMessage, raw: string, xai: XaiProvider | null, res: ServerResponse) {
  if (!xai) return json(res, 503, { error: "xai provider not configured" });
  if (path === "/webhooks/xai") {
    const v = verifyXaiWebhook(req.headers as Record<string, string | undefined>, raw, config.xai.webhookSecret);
    if (!v.ok) { log.warn("xai.webhook.rejected", { reason: v.reason }); return json(res, 401, { error: v.reason }); }
    const payload = JSON.parse(raw) as { type?: string; data?: Record<string, unknown> };
    log.info("xai.webhook", { type: payload.type });
    if (payload.type && payload.type !== "realtime.call.incoming") return json(res, 200, { ignored: payload.type });
    return json(res, 200, xai.handleXaiIncoming(payload));
  }
  const form = Object.fromEntries(new URLSearchParams(raw));
  // Twilio signs with X-Twilio-Signature; validation requires the exact public URL. Enabled when PUBLIC_BASE_URL is set.
  if (config.twilio.validateSignature && config.twilio.authToken && config.publicBaseUrl && !verifyTwilioSignature(req, path, form)) {
    log.warn("twilio.webhook.rejected", { path, call_sid: form.CallSid, status: form.CallStatus, expected_url: `${config.publicBaseUrl}${path}`, hint: "PUBLIC_BASE_URL must match the exact URL Twilio calls (scheme, host, no port rewrite). Set TWILIO_VALIDATE_SIGNATURE=false to bypass while debugging." });
    return json(res, 401, { error: "bad twilio signature" });
  }
  log.debug("twilio.webhook", { path, call_sid: form.CallSid, parent: form.ParentCallSid, status: form.CallStatus, answered_by: form.AnsweredBy });
  if (path === "/webhooks/twilio/status") { xai.handleTwilioStatus(form); return json(res, 200, { ok: true }); }
  if (path === "/webhooks/twilio/amd") { xai.handleTwilioAmd(form); return json(res, 200, { ok: true }); }
  return json(res, 404, { error: "not found" });
}

function verifyTwilioSignature(req: IncomingMessage, path: string, form: Record<string, string>): boolean {
  const url = `${config.publicBaseUrl}${path}`;
  const data = url + Object.keys(form).sort().map((k) => k + form[k]).join("");
  const expected = createHmac("sha1", config.twilio.authToken).update(data).digest("base64");
  const got = String(req.headers["x-twilio-signature"] ?? "");
  return got.length === expected.length && timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let d = ""; req.on("data", (c) => { d += c; if (d.length > 1_000_000) reject(new Error("body too large")); });
    req.on("end", () => resolve(d)); req.on("error", reject);
  });
}
function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const isMain = process.argv[1]?.endsWith("http.ts") || process.argv[1]?.endsWith("http.js");
if (isMain) {
  const { service, xai } = createService();
  createHttpServer(service, xai).listen(config.port, () => log.info("http.listening", { port: config.port, public_base_url: config.publicBaseUrl || null }));
}
