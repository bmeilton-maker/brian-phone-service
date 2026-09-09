import { config } from "../../config.js";
import { buildAgentInstructions } from "../../envelope.js";
import { log } from "../../logger.js";
import type { CallState, PhoneProvider, ProviderCallOutcome, StartCallInput, StartCallResult, TranscriptTurn } from "../../types.js";
import { TwilioClient } from "./twilio.js";
import { XaiRealtimeSession, TOOL_NAMES, type WsLike } from "./realtime.js";

/**
 * XaiProvider: outbound via Twilio -> xAI Direct SIP -> realtime session.
 *
 *  1. startCall: Twilio dials xAI's Direct SIP number first (parent leg). xAI answers at once and POSTs
 *     `realtime.call.incoming` to PUBLIC_BASE_URL/webhooks/xai (signed). We correlate it to the pending task
 *     (X-Task-Id SIP header if surfaced, else the oldest pending dial) and open wss://api.x.ai/v1/realtime?call_id=...
 *     with the envelope as session.instructions. The agent's greeting is HELD.
 *  2. TwiML on that answered leg <Dial>s the human (child PSTN leg). Because the line is already live, the
 *     callee is bridged to the agent the instant they pick up; no ringback is played to them.
 *  3. Child-leg status callbacks (ParentCallSid = our call_id) drive ringing/answered/completed; the greeting is
 *     released on "in-progress". AMD on the child leg marks voicemail.
 *  4. The agent calls report_outcome / ask_owner / end_call; end_call hangs up via Twilio AND finalizes locally,
 *     so a lost callback cannot leave the call stuck in_progress. Socket close and getOutcome() also reconcile
 *     against Twilio when callbacks go quiet.
 *
 * State lives in memory (one process) plus the CallStore's event log written by PhoneService.
 */

interface XaiCall {
  task_id: string;
  twilio_sid: string; // parent (xAI SIP) leg; our call_id
  pstn_sid: string | null; // child (human) leg
  xai_call_id: string | null;
  last_status_at: number;
  reconciling: boolean;
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
      task_id: input.task_id, twilio_sid: sid, pstn_sid: null, xai_call_id: null, last_status_at: this.now(), reconciling: false, input, state: "dialing", started_at: this.now(), answered_at: null, ended_at: null,
      human_answered: null, voicemail: null, error: null, session: null, turns: [], outcome: null, pendingQuestion: null, raw: { provider: "xai", twilio: raw },
    });
    return { call_id: sid, state: "dialing", raw };
  }

  /**
   * Twilio status callback (form-encoded). Two legs report here:
   *   parent (CallSid === twilio_sid): the xAI SIP leg. "in-progress" = xAI answered; "completed" = whole call over.
   *   child  (ParentCallSid === twilio_sid): the human PSTN leg. This is the leg that defines answered/busy/no-answer
   *   and the true talk duration (CallDuration).
   */
  handleTwilioStatus(form: Record<string, string>): void {
    const sid = form.CallSid ?? "";
    const parentSid = form.ParentCallSid ?? "";
    const c = this.calls.get(sid) ?? this.calls.get(parentSid) ?? [...this.calls.values()].find((x) => x.pstn_sid === sid);
    if (!c) { log.warn("twilio.status.unknown_sid", { sid, parent: parentSid }); return; }
    const isChild = sid !== c.twilio_sid;
    if (isChild && !c.pstn_sid) c.pstn_sid = sid;
    c.last_status_at = this.now();
    const s = form.CallStatus;
    log.info("twilio.status", { task_id: c.task_id, leg: isChild ? "pstn" : "xai_sip", sid, status: s, duration: form.CallDuration });
    // Always capture Twilio's measured durations, even on late callbacks after we finalized locally.
    if (s === "completed" && form.CallDuration) c.raw[isChild ? "pstn_duration" : "twilio_duration"] = Number(form.CallDuration);
    if (c.ended_at) return;

    if (isChild) {
      if (s === "initiated") c.state = c.state === "dialing" ? "dialing" : c.state;
      else if (s === "ringing") { if (c.state === "dialing") c.state = "ringing"; }
      else if (s === "in-progress" || s === "answered") this.markAnswered(c);
      else if (s === "busy") this.end(c, "failed", "busy");
      else if (s === "no-answer") this.end(c, "failed", "no_answer");
      else if (s === "failed") this.end(c, "failed", form.ErrorMessage ?? "failed");
      else if (s === "canceled") this.end(c, "cancelled", "cancelled");
      else if (s === "completed") {
        if (!c.answered_at) this.end(c, "failed", "no_answer");
        else this.end(c, "completed", null);
      }
      return;
    }
    // parent (xAI SIP leg)
    if (s === "in-progress" || s === "answered") c.raw.sip_answered_at = new Date(this.now()).toISOString();
    else if (s === "busy" || s === "no-answer" || s === "failed") this.end(c, "failed", `xai_sip_${s}`);
    else if (s === "canceled") this.end(c, "cancelled", "cancelled");
    else if (s === "completed") {
      if (!c.answered_at && c.turns.every((t) => t.speaker !== "human")) this.end(c, "failed", c.error ?? "no_answer");
      else this.end(c, "completed", c.error);
    }
  }

  private markAnswered(c: XaiCall) {
    if (!c.answered_at) c.answered_at = this.now();
    c.human_answered ??= true;
    if (c.state !== "needs_user") c.state = "in_progress";
    c.session?.onHumanAnswered();
  }

  /** Twilio async AMD callback: AnsweredBy = human | machine_start | machine_end_beep | machine_end_silence | machine_end_other | fax | unknown */
  handleTwilioAmd(form: Record<string, string>): void {
    const sid = form.CallSid ?? "";
    const c = this.calls.get(sid) ?? [...this.calls.values()].find((x) => x.pstn_sid === sid);
    if (!c) return;
    if (!c.pstn_sid && sid !== c.twilio_sid) c.pstn_sid = sid;
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
      // Hold the opening line until the human leg answers; release in markAnswered().
      deferGreeting: !c.answered_at,
      greetingWaitMs: config.xai.greetingWaitMs,
      autoResponseGraceMs: config.xai.autoResponseGraceMs,
      hooks: {
        onAskOwner: (question, options) => this.holdForOwner(c, question, options),
        onEndCall: async (reason) => {
          c.raw.end_reason = reason;
          await this.twilio.hangup(c.twilio_sid).catch((e) => log.warn("twilio.hangup_failed", { error: String(e) }));
          // Finalize now; the call state is "completed" (the agent chose to end it). The RESULT status
          // (success/partial/failed/needs_user) comes from report_outcome + extraction, not from here.
          this.end(c, "completed", null);
        },
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
    session.on("closed", () => {
      if (c.ended_at) return;
      log.info("xai.realtime.closed_before_twilio_end", { task_id: c.task_id });
      // xAI dropped the socket (their side hung up or the SIP leg ended). Reconcile with Twilio instead of waiting.
      void this.reconcile(c);
    });
    session.on("error", (e: Error) => { c.raw.realtime_error = String(e); });
    session.on("greeting_fallback", () => { c.raw.greeting_fallback = true; log.info("xai.greeting_fallback", { task_id: c.task_id, note: "human did not speak after pickup; agent opened" }); });
    c.session = session;
    // The SIP leg is live but the human is not on yet (unless the child leg already reported answered).
    if (c.answered_at) c.state = c.state === "needs_user" ? c.state : "in_progress";
    session.connect();
    if (c.answered_at) session.onHumanAnswered();
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

  /** Ask Twilio for the parent leg's real state when callbacks have gone quiet or the socket closed. */
  private async reconcile(c: XaiCall): Promise<void> {
    if (c.ended_at || c.reconciling) return;
    c.reconciling = true;
    try {
      const t = await this.twilio.fetch(c.twilio_sid).catch(() => null);
      const status = String(t?.status ?? "");
      log.info("twilio.reconcile", { task_id: c.task_id, sid: c.twilio_sid, status });
      if (["completed", "failed", "busy", "no-answer", "canceled"].includes(status)) {
        this.handleTwilioStatus({ CallSid: c.twilio_sid, CallStatus: status, CallDuration: String(t?.duration ?? "") });
      } else if (!t && this.now() - c.started_at > (c.input.max_duration_seconds + 60) * 1000) {
        this.end(c, "failed", "provider_timeout");
      }
    } finally {
      c.reconciling = false;
    }
  }

  async getOutcome(call_id: string): Promise<ProviderCallOutcome> {
    const c = this.calls.get(call_id);
    if (!c) throw new Error(`xai: unknown call ${call_id}`);
    if (!c.ended_at) {
      const quiet = this.now() - c.last_status_at > config.twilio.reconcileAfterMs;
      const overMax = this.now() - c.started_at > (c.input.max_duration_seconds + 60) * 1000;
      if (c.session?.closed || quiet || overMax) await this.reconcile(c);
    }
    const ended = !!c.ended_at;
    // Talk time only: PSTN answered -> ended. Prefer Twilio's own child-leg duration when it reported one.
    const pstnDuration = typeof c.raw.pstn_duration === "number" ? (c.raw.pstn_duration as number) : null;
    const duration = ended && pstnDuration != null ? pstnDuration : c.answered_at ? Math.round(((c.ended_at ?? this.now()) - c.answered_at) / 1000) : null;
    const transcript = c.turns.map((t) => `${t.speaker}: ${t.text}`).join("\n");
    return {
      call_id, ended, state: c.state,
      human_answered: ended ? (c.human_answered ?? (c.turns.some((t) => t.speaker === "human") ? true : false)) : c.human_answered,
      voicemail: ended ? (c.voicemail ?? false) : c.voicemail,
      duration_seconds: duration, transcript, transcript_turns: c.turns,
      recording_reference: null, // Twilio call recording not enabled by default; see runbook.
      error: c.error ?? (ended && c.turns.length === 0 && !c.voicemail ? "no_transcript" : null),
      cost_usd: null,
      provider_extraction: c.outcome ? (c.outcome as ProviderCallOutcome["provider_extraction"]) : null,
      raw: { ...c.raw, provider: "xai", xai_call_id: c.xai_call_id, twilio_sid: c.twilio_sid, pstn_sid: c.pstn_sid, answered_at: c.answered_at ? new Date(c.answered_at).toISOString() : null, ended_at: c.ended_at ? new Date(c.ended_at).toISOString() : null, pending_question: c.pendingQuestion ? { id: c.pendingQuestion.id, question: c.pendingQuestion.question, options: c.pendingQuestion.options, asked_at: c.pendingQuestion.asked_at } : null },
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
