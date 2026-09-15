import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import { WebSocketServer } from "ws";
import { config } from "../config.js";
import { log } from "../logger.js";
import { createService } from "../bootstrap.js";
import { verifyXaiWebhook } from "../providers/xai/webhook.js";
import type { PhoneService } from "../service.js";
import type { XaiProvider } from "../providers/xai/index.js";
import type { OpenAiLiveProvider } from "../providers/openai_live/index.js";
import type { MakeCallRequest } from "../types.js";

/**
 * HTTP API (provider-independent) + provider webhooks.
 *   POST /calls                                phone.make_call
 *   GET  /calls                                list
 *   GET  /calls/:id/status                     phone.get_status   (:id = task_id or call_id)
 *   GET  /calls/:id/result                     phone.get_result
 *   POST /calls/:id/cancel                     phone.cancel_call
 *   POST /calls/:id/answer                     needs_user answer {question_id, answer}
 *   POST /webhooks/xai                         realtime.call.incoming (signed)               [xai]
 *   POST /webhooks/twilio/status               Twilio status callback (xAI legs)             [xai]
 *   POST /webhooks/twilio/amd                  Twilio async AMD callback (xAI child leg)     [xai]
 *   POST /webhooks/openai-live/twilio/status   Twilio status callback                        [openai_live]
 *   POST /webhooks/openai-live/twilio/amd      Twilio async AMD callback                     [openai_live]
 *   WS   /webhooks/openai-live/media           Twilio Media Streams (bidirectional mu-law)   [openai_live]
 *   GET  /healthz
 */
export interface WebhookProviders {
  xai?: XaiProvider | null;
  openaiLive?: OpenAiLiveProvider | null;
}

export function createHttpServer(service: PhoneService, providers: WebhookProviders | XaiProvider | null = {}) {
  // Back-compat: the old signature took the xai provider directly.
  const p: WebhookProviders = providers && "handleXaiIncoming" in providers ? { xai: providers as XaiProvider } : ((providers ?? {}) as WebhookProviders);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const t0 = Date.now();
    try {
      const raw = await readBody(req);
      const path = url.pathname;
      if (path === "/healthz") return json(res, 200, { ok: true, default_provider: config.provider, providers: service.providerNames });

      if (path.startsWith("/webhooks/")) return await handleWebhook(path, req, raw, p, res);

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

  // Twilio Media Streams for openai_live. Twilio opens one WebSocket per answered call; the `start` frame carries the
  // CallSid we dialed, and the provider drops any stream whose CallSid it did not place.
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (path !== "/webhooks/openai-live/media" || !p.openaiLive) { socket.write("HTTP/1.1 404 Not Found\r\n\r\n"); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      log.info("openai_live.media.connected", {});
      p.openaiLive!.attachMediaStream(ws);
    });
  });
  return server;
}

async function handleWebhook(path: string, req: IncomingMessage, raw: string, p: WebhookProviders, res: ServerResponse) {
  if (path === "/webhooks/xai") {
    if (!p.xai) return json(res, 503, { error: "xai provider not configured" });
    const v = verifyXaiWebhook(req.headers as Record<string, string | undefined>, raw, config.xai.webhookSecret);
    if (!v.ok) { log.warn("xai.webhook.rejected", { reason: v.reason }); return json(res, 401, { error: v.reason }); }
    const payload = JSON.parse(raw) as { type?: string; data?: Record<string, unknown> };
    log.info("xai.webhook", { type: payload.type });
    if (payload.type && payload.type !== "realtime.call.incoming") return json(res, 200, { ignored: payload.type });
    return json(res, 200, p.xai.handleXaiIncoming(payload));
  }
  const form = Object.fromEntries(new URLSearchParams(raw));
  // Twilio signs with X-Twilio-Signature; validation requires the exact public URL. Enabled when PUBLIC_BASE_URL is set.
  if (config.twilio.validateSignature && config.twilio.authToken && config.publicBaseUrl && !verifyTwilioSignature(req, path, form)) {
    log.warn("twilio.webhook.rejected", { path, call_sid: form.CallSid, status: form.CallStatus, expected_url: `${config.publicBaseUrl}${path}`, hint: "PUBLIC_BASE_URL must match the exact URL Twilio calls (scheme, host, no port rewrite). Set TWILIO_VALIDATE_SIGNATURE=false to bypass while debugging." });
    return json(res, 401, { error: "bad twilio signature" });
  }
  log.debug("twilio.webhook", { path, call_sid: form.CallSid, parent: form.ParentCallSid, status: form.CallStatus, answered_by: form.AnsweredBy });
  if (path === "/webhooks/twilio/status" || path === "/webhooks/twilio/amd") {
    if (!p.xai) return json(res, 503, { error: "xai provider not configured" });
    if (path.endsWith("/status")) p.xai.handleTwilioStatus(form); else p.xai.handleTwilioAmd(form);
    return json(res, 200, { ok: true });
  }
  if (path === "/webhooks/openai-live/twilio/status" || path === "/webhooks/openai-live/twilio/amd") {
    if (!p.openaiLive) return json(res, 503, { error: "openai_live provider not configured" });
    if (path.endsWith("/status")) p.openaiLive.handleTwilioStatus(form); else p.openaiLive.handleTwilioAmd(form);
    return json(res, 200, { ok: true });
  }
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
  const { service, xai, openaiLive } = createService();
  createHttpServer(service, { xai, openaiLive }).listen(config.port, () => log.info("http.listening", { port: config.port, public_base_url: config.publicBaseUrl || null }));
}
