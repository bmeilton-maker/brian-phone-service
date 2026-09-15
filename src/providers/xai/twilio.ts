import { config } from "../../config.js";
import { log } from "../../logger.js";

/**
 * Minimal Twilio REST client (no SDK).
 *
 * Call topology (SIP-first, so the callee never hears ringback):
 *   1. POST /Calls.json  To=sip:{XAI_SIP_NUMBER}@sip.voice.x.ai?X-Task-Id=...   (parent leg)
 *      xAI answers the SIP leg immediately and fires realtime.call.incoming -> we attach the session.
 *   2. TwiML on the answered SIP leg: <Dial><Number ...>{callee}</Number></Dial>  (child PSTN leg)
 *      The callee is dialed from an already-answered line; on pickup they are bridged straight to the agent.
 *      The agent's opening line is held until the child leg reports "in-progress" (see XaiProvider).
 *   Status callbacks: parent via StatusCallback on the API call; child via <Number statusCallback>.
 *   AMD (voicemail detection) runs on the child leg via <Number machineDetection amdStatusCallback>.
 *
 * Twilio docs: POST /2010-04-01/Accounts/{Sid}/Calls.json; TwiML <Dial>/<Number> attributes
 * statusCallback, statusCallbackEvent, machineDetection, amdStatusCallback; POST /Calls/{Sid}.json Status=completed.
 */
export interface TwilioHttp {
  form(method: "POST" | "GET", path: string, form?: Record<string, string>): Promise<{ status: number; json: Record<string, unknown> }>;
}

export function xaiSipUri(taskId: string): string {
  // Custom SIP headers ride as query params on the SIP URI (Twilio feature).
  // VERIFY: whether xAI surfaces X-Task-Id in realtime.call.incoming. Fallback correlation is in XaiProvider.matchIncoming.
  return `sip:${config.xai.sipNumber}@${config.xai.sipDomain};transport=tls?X-Task-Id=${encodeURIComponent(taskId)}`;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/** TwiML executed on the answered xAI SIP leg: dial the human from an already-live line. No ringback to the callee. */
export function dialCalleeTwiml(opts: { to: string; from: string; maxDurationSeconds: number; publicBaseUrl: string; ringTimeoutSeconds?: number }): string {
  const cb = `${opts.publicBaseUrl}/webhooks/twilio/status`;
  const amd = `${opts.publicBaseUrl}/webhooks/twilio/amd`;
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Dial callerId="${esc(opts.from)}" timeout="${opts.ringTimeoutSeconds ?? 40}" timeLimit="${opts.maxDurationSeconds}" answerOnBridge="false">` +
    `<Number statusCallback="${esc(cb)}" statusCallbackEvent="initiated ringing answered completed" statusCallbackMethod="POST" ` +
    `machineDetection="Enable" amdStatusCallback="${esc(amd)}" amdStatusCallbackMethod="POST">${esc(opts.to)}</Number></Dial></Response>`;
}

/** @deprecated PSTN-first bridge; kept only so old tests/docs still resolve. Caused callee-side ringback. */
export function bridgeTwiml(taskId: string, maxDurationSeconds: number): string {
  const uri = xaiSipUri(taskId).replace(/&/g, "&amp;");
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Dial answerOnBridge="true" timeLimit="${maxDurationSeconds}"><Sip>${uri}</Sip></Dial></Response>`;
}

export class TwilioClient {
  constructor(private http: TwilioHttp = defaultHttp()) {}

  async dial(opts: { to: string; taskId: string; maxDurationSeconds: number; publicBaseUrl: string }) {
    const form: Record<string, string> = {
      To: xaiSipUri(opts.taskId),
      From: config.twilio.fromNumber,
      Twiml: dialCalleeTwiml({ to: opts.to, from: config.twilio.fromNumber, maxDurationSeconds: opts.maxDurationSeconds, publicBaseUrl: opts.publicBaseUrl }),
      StatusCallback: `${opts.publicBaseUrl}/webhooks/twilio/status`,
      StatusCallbackEvent: "initiated ringing answered completed",
      StatusCallbackMethod: "POST",
      Timeout: "20",
    };
    const r = await this.createCall(form);
    log.info("twilio.dialed", { task_id: opts.taskId, call_sid: r.sid, sip_leg: "xai", callee: opts.to });
    return r;
  }

  /** Generic POST /Calls.json; providers build their own form (SIP-first for xAI, Media Streams for openai_live). */
  async createCall(form: Record<string, string>) {
    const { status, json } = await this.http.form("POST", `/2010-04-01/Accounts/${config.twilio.accountSid}/Calls.json`, form);
    if (status >= 300 || !json.sid) throw new Error(`Twilio dial failed (${status}): ${String(json.message ?? JSON.stringify(json)).slice(0, 300)}`);
    return { sid: String(json.sid), raw: json };
  }

  async hangup(sid: string) {
    const { status, json } = await this.http.form("POST", `/2010-04-01/Accounts/${config.twilio.accountSid}/Calls/${sid}.json`, { Status: "completed" });
    return { ok: status < 300, raw: json };
  }

  async fetch(sid: string) {
    const { json } = await this.http.form("GET", `/2010-04-01/Accounts/${config.twilio.accountSid}/Calls/${sid}.json`);
    return json;
  }
}

function defaultHttp(): TwilioHttp {
  return {
    async form(method, path, form) {
      if (!config.twilio.accountSid || !config.twilio.authToken) throw new Error("TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN not set");
      const auth = Buffer.from(`${config.twilio.accountSid}:${config.twilio.authToken}`).toString("base64");
      const res = await fetch(`https://api.twilio.com${path}`, {
        method,
        headers: { authorization: `Basic ${auth}`, ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}) },
        body: form ? new URLSearchParams(form).toString() : undefined,
      });
      const text = await res.text();
      let json: Record<string, unknown> = {};
      try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
      return { status: res.status, json };
    },
  };
}
