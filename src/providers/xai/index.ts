import { config } from "../../config.js";
import { buildAgentInstructions } from "../../envelope.js";
import { log } from "../../logger.js";
import type { CallState, PhoneProvider, ProviderCallOutcome, StartCallInput, StartCallResult, TranscriptTurn } from "../../types.js";
import { TwilioClient } from "./twilio.js";
import { XaiRealtimeSession, TOOL_NAMES, type WsLike } from "./realtime.js";

/**
 * XaiProvider: outbound via Twilio -> xAI Direct SIP -> realtime session.
 *
 *  1. startCall: Twilio dials the recipient; TwiML bridges the answered leg to sip:{XAI_SIP_NUMBER}@sip.voice.x.ai.
 *  2. xAI POSTs `realtime.call.incoming` to PUBLIC_BASE_URL/webhooks/xai (signed). We correlate it to the
 *     pending task (X-Task-Id SIP header if surfaced, else the oldest pending dial) and open
 *     wss://api.x.ai/v1/realtime?call_id=... with the envelope as session.instructions.
 *  3. Twilio status callbacks mark ringing/answered/completed; AMD callback marks voicemail.
 *  4. The agent calls report_outcome / ask_owner / end_call tools; end_call hangs up via Twilio.
 *
 * State lives in memory (one process) plus the CallStore's event log written by PhoneService.
 */

interface XaiCall {
  task_id: string;
  twilio_sid: string;
  xai_call_id: string | null;
  input: StartCallInput;
  state: CallState;
  started_at: number;
  answered_at: number | null;
  ended_at: number | null;
  human_answered: boolean | null;
  voicemail: boolean | null;
  error: string | null;
  session: XaiRealtimeSession | null;
  turns: TranscriptTurn[];
  outcome: Record<string, unknown> | null;
  pendingQuestion: { id: string; question: string; options?: string[]; asked_at: string; resolve: (a: string | null) => void } | null;
  raw: Record<string, unknown>;
}

export interface XaiProviderDeps {
  twilio?: TwilioClient;
  wsFactory?: (url: string, headers: Record<string, string>) => WsLike;
  now?: () => number;
}

export class XaiProvider implements PhoneProvider {
  readonly name = "xai" as const;
  private calls = new Map<string, XaiCall>(); // keyed by twilio sid (our call_id)
  private twilio: TwilioClient;
  private now: () => number;
  constructor(private deps: XaiProviderDeps = {}) {
    this.twilio = deps.twilio ?? new TwilioClient();
    this.now = deps.now ?? (() => Date.now());
  }

  static preflight(): string[] {
    const missing: string[] = [];
    if (!config.xai.apiKey) missing.push("XAI_API_KEY");
    if (!config.xai.sipNumber) missing.push("XAI_SIP_NUMBER");
    if (!config.xai.webhookSecret) missing.push("XAI_WEBHOOK_SECRET");
    if (!config.twilio.accountSid) missing.push("TWILIO_ACCOUNT_SID");
    if (!config.twilio.authToken) missing.push("TWILIO_AUTH_TOKEN");
    if (!config.twilio.fromNumber) missing.push("TWILIO_FROM_NUMBER");
    if (!config.publicBaseUrl) missing.push("PUBLIC_BASE_URL");
    return missing;
  }

  async startCall(input: StartCallInput): Promise<StartCallResult> {
    const missing = XaiProvider.preflight();
    if (missing.length) throw new Error(`xai provider not configured: missing ${missing.join(", ")}`);
    const { sid, raw } = await this.twilio.dial({ to: input.phone_number, taskId: input.task_id, maxDurationSeconds: input.max_duration_seconds, publicBaseUrl: config.publicBaseUrl });
    this.calls.set(sid, {
      task_id: input.task_id, twilio_sid: sid, xai_call_id: null, input, state: "dialing", started_at: this.now(), answered_at: null, ended_at: null,
      human_answered: null, voicemail: null, error: null, session: null, turns: [], outcome: null, pendingQuestion: null, raw: { provider: "xai", twilio: raw },
    });
    return { call_id: sid, state: "dialing", raw };
  }

  /** Twilio status callback (form-encoded): CallSid, CallStatus, CallDuration, AnsweredBy... */
  handleTwilioStatus(form: Record<string, string>): void {
    const c = this.calls.get(form.CallSid ?? "");
    if (!c) { log.warn("twilio.status.unknown_sid", { sid: form.CallSid }); return; }
    const s = form.CallStatus;
    log.info("twilio.status", { task_id: c.task_id, sid: c.twilio_sid, status: s });
    if (s === "ringing") c.state = c.state === "dialing" ? "ringing" : c.state;
    else if (s === "in-progress" || s === "answered") { c.state = c.state === "needs_user" ? c.state : "in_progress"; c.answered_at ??= this.now(); c.human_answered ??= true; }
    else if (s === "busy") this.end(c, "failed", "busy");
    else if (s === "no-answer") this.end(c, "failed", "no_answer");
    else if (s === "failed" || s === "canceled") this.end(c, s === "canceled" ? "cancelled" : "failed", form.ErrorMessage ?? s);
    else if (s === "completed") {
      if (form.CallDuration) c.raw.twilio_duration = Number(form.CallDuration);
      this.end(c, c.state === "failed" ? "failed" : "completed", c.error);
    }
  }

  /** Twilio async AMD callback: AnsweredBy = human | machine_start | machine_end_beep | machine_end_silence | machine_end_other | fax | unknown */
  handleTwilioAmd(form: Record<string, string>): void {
    const c = this.calls.get(form.CallSid ?? "");
    if (!c) return;
    const by = form.AnsweredBy ?? "unknown";
    c.raw.answered_by = by;
    if (by.startsWith("machine")) { c.voicemail = true; c.human_answered = false; }
    else if (by === "human") { c.voicemail = false; c.human_answered = true; }
    log.info("twilio.amd", { task_id: c.task_id, answered_by: by });
  }

  /** xAI `realtime.call.incoming` webhook (already signature-verified by the HTTP layer). */
  handleXaiIncoming(payload: { type?: string; data?: Record<string, unknown> }): { attached: boolean; task_id?: string; reason?: string } {
    const data = payload.data ?? {};
    const xaiCallId = String(data.call_id ?? "");
    if (!xaiCallId) return { attached: false, reason: "no call_id in payload" };
    const c = this.matchIncoming(data);
    if (!c) return { attached: false, reason: "no pending outbound call to attach" };
    c.xai_call_id = xaiCallId;
    c.raw.xai_incoming = data;
    const instructions = buildAgentInstructions(c.input.envelope, {
      recipient_name: c.input.recipient_name, opening_instruction: c.input.opening_instruction,
      realtime_hold_supported: true, hold_seconds: config.needsUserHoldSeconds, tools: [...TOOL_NAMES],
    });
    const session = new XaiRealtimeSession({
      call_id: xaiCallId, instructions, voice: c.input.preferred_voice ?? config.xai.voice, ownerName: c.input.envelope.identity.owner_name,
      wsFactory: this.deps.wsFactory,
      hooks: {
        onAskOwner: (question, options) => this.holdForOwner(c, question, options),
        onEndCall: async (reason) => { c.raw.end_reason = reason; await this.twilio.hangup(c.twilio_sid).catch((e) => log.warn("twilio.hangup_failed", { error: String(e) })); },
        onSendDtmf: async (digits) => {
          // VERIFY: DTMF injection on a Twilio<->xAI SIP bridge. Not available from the realtime socket today;
          // the agent is instructed to ask for a representative when this returns ok:false.
          log.warn("xai.dtmf_unsupported", { task_id: c.task_id, digits });
          return { ok: false, message: "DTMF not supported on this call path; say 'representative' or wait for a person" };
        },
      },
    });
    session.on("turn", (t: TranscriptTurn) => c.turns.push(t));
    session.on("outcome", (o: Record<string, unknown>) => { c.outcome = o; });
    session.on("closed", () => { if (!c.ended_at) log.info("xai.realtime.closed_before_twilio_end", { task_id: c.task_id }); });
    session.on("error", (e: Error) => { c.raw.realtime_error = String(e); });
    c.session = session;
    c.state = "in_progress";
    c.answered_at ??= this.now();
    session.connect();
    log.info("xai.session_attached", { task_id: c.task_id, xai_call_id: xaiCallId });
    return { attached: true, task_id: c.task_id };
  }

  private matchIncoming(data: Record<string, unknown>): XaiCall | undefined {
    const headers = (data.sip_headers ?? data.headers ?? {}) as Record<string, string>;
    const hinted = headers["X-Task-Id"] ?? headers["x-task-id"] ?? (data.task_id as string | undefined);
    const pending = [...this.calls.values()].filter((c) => !c.xai_call_id && !c.ended_at);
    if (hinted) { const hit = pending.find((c) => c.task_id === hinted); if (hit) return hit; }
    // Fallback: oldest pending dial. Safe because this service places calls one at a time per process
    // (PhoneService serializes xai dials); see docs/XAI_RUNBOOK.md.
    return pending.sort((a, b) => a.started_at - b.started_at)[0];
  }

  private holdForOwner(c: XaiCall, question: string, options?: string[]): Promise<string | null> {
    return new Promise((resolve) => {
      const id = `q_${this.now()}`;
      const timer = setTimeout(() => { if (c.pendingQuestion?.id === id) { c.pendingQuestion = null; c.state = "in_progress"; resolve(null); } }, config.needsUserHoldSeconds * 1000);
      c.pendingQuestion = { id, question, options, asked_at: new Date(this.now()).toISOString(), resolve: (a) => { clearTimeout(timer); c.pendingQuestion = null; c.state = "in_progress"; resolve(a); } };
      c.state = "needs_user";
      log.info("xai.needs_user", { task_id: c.task_id, question, options, hold_seconds: config.needsUserHoldSeconds });
    });
  }

  async answerQuestion(call_id: string, question_id: string, answer: string) {
    const c = this.calls.get(call_id);
    if (!c?.pendingQuestion) return { delivered: false, message: "no pending question" };
    if (question_id && c.pendingQuestion.id !== question_id) return { delivered: false, message: "question id mismatch (stale)" };
    c.pendingQuestion.resolve(answer);
    return { delivered: true };
  }

  private end(c: XaiCall, state: CallState, error: string | null) {
    if (c.ended_at) return;
    c.ended_at = this.now();
    c.state = state;
    c.error = error;
    c.pendingQuestion?.resolve(null);
    c.session?.close();
    log.info("xai.call_ended", { task_id: c.task_id, state, error });
  }

  async getOutcome(call_id: string): Promise<ProviderCallOutcome> {
    const c = this.calls.get(call_id);
    if (!c) throw new Error(`xai: unknown call ${call_id}`);
    // Safety net: if the Twilio 'completed' callback never arrives, poll Twilio once the max duration has passed.
    if (!c.ended_at && this.now() - c.started_at > (c.input.max_duration_seconds + 60) * 1000) {
      const t = await this.twilio.fetch(c.twilio_sid).catch(() => null);
      if (t && ["completed", "failed", "busy", "no-answer", "canceled"].includes(String(t.status))) this.handleTwilioStatus({ CallSid: c.twilio_sid, CallStatus: String(t.status), CallDuration: String(t.duration ?? "") });
      else this.end(c, "failed", "provider_timeout");
    }
    const ended = !!c.ended_at;
    const duration = c.answered_at ? Math.round(((c.ended_at ?? this.now()) - c.answered_at) / 1000) : null;
    const transcript = c.turns.map((t) => `${t.speaker}: ${t.text}`).join("\n");
    return {
      call_id, ended, state: c.state,
      human_answered: ended ? (c.human_answered ?? (c.turns.some((t) => t.speaker === "human") ? true : false)) : c.human_answered,
      voicemail: ended ? (c.voicemail ?? false) : c.voicemail,
      duration_seconds: duration, transcript, transcript_turns: c.turns,
      recording_reference: null, // Twilio call recording not enabled on the bridge leg by default; see runbook.
      error: c.error ?? (ended && c.turns.length === 0 && !c.voicemail ? "no_transcript" : null),
      cost_usd: null,
      provider_extraction: c.outcome ? (c.outcome as ProviderCallOutcome["provider_extraction"]) : null,
      raw: { ...c.raw, provider: "xai", xai_call_id: c.xai_call_id, twilio_sid: c.twilio_sid, pending_question: c.pendingQuestion ? { id: c.pendingQuestion.id, question: c.pendingQuestion.question, options: c.pendingQuestion.options, asked_at: c.pendingQuestion.asked_at } : null },
    };
  }

  async cancelCall(call_id: string) {
    const c = this.calls.get(call_id);
    if (!c) return { cancelled: false, message: "unknown call" };
    if (c.ended_at) return { cancelled: false, message: "already ended" };
    const r = await this.twilio.hangup(c.twilio_sid);
    if (r.ok) this.end(c, "cancelled", "cancelled");
    return { cancelled: r.ok };
  }
}
