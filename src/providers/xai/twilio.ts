import { config } from "../../config.js";
import { log } from "../../logger.js";

/**
 * Minimal Twilio REST client (no SDK). Dials the PSTN leg, then bridges the answered call
 * into xAI's Direct SIP number so xAI raises the `realtime.call.incoming` webhook.
 *
 * Twilio docs: POST /2010-04-01/Accounts/{Sid}/Calls.json (To, From, Twiml, StatusCallback,
 * MachineDetection, AsyncAmd, AsyncAmdStatusCallback); POST /Calls/{Sid}.json Status=completed.
 */
export interface TwilioHttp {
  form(method: "POST" | "GET", path: string, form?: Record<string, string>): Promise<{ status: number; json: Record<string, unknown> }>;
}

export function xaiSipUri(taskId: string): string {
  // Custom SIP headers are appended as query params on the SIP URI (Twilio <Sip> noun feature).
  // VERIFY: whether xAI surfaces X-Task-Id in the realtime.call.incoming payload. We fall back to
  // pending-call correlation if it does not (see XaiProvider.matchIncoming).
  const hdr = encodeURIComponent(taskId);
  return `sip:${config.xai.sipNumber}@${config.xai.sipDomain};transport=tls?X-Task-Id=${hdr}`;
}

export function bridgeTwiml(taskId: string, maxDurationSeconds: number): string {
  const uri = xaiSipUri(taskId).replace(/&/g, "&amp;");
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Dial answerOnBridge="true" timeLimit="${maxDurationSeconds}"><Sip>${uri}</Sip></Dial></Response>`;
}

export class TwilioClient {
  constructor(private http: TwilioHttp = defaultHttp()) {}

  async dial(opts: { to: string; taskId: string; maxDurationSeconds: number; publicBaseUrl: string }) {
    const cb = `${opts.publicBaseUrl}/webhooks/twilio/status`;
    const form: Record<string, string> = {
      To: opts.to,
      From: config.twilio.fromNumber,
      Twiml: bridgeTwiml(opts.taskId, opts.maxDurationSeconds),
      StatusCallback: cb,
      StatusCallbackEvent: "initiated ringing answered completed",
      StatusCallbackMethod: "POST",
      MachineDetection: "Enable",
      AsyncAmd: "true",
      AsyncAmdStatusCallback: `${opts.publicBaseUrl}/webhooks/twilio/amd`,
      AsyncAmdStatusCallbackMethod: "POST",
      Timeout: "40",
    };
    const { status, json } = await this.http.form("POST", `/2010-04-01/Accounts/${config.twilio.accountSid}/Calls.json`, form);
    if (status >= 300 || !json.sid) throw new Error(`Twilio dial failed (${status}): ${String(json.message ?? JSON.stringify(json)).slice(0, 300)}`);
    log.info("twilio.dialed", { task_id: opts.taskId, call_sid: json.sid, to: opts.to });
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
