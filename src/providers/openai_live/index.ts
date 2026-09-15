import { config } from "../../config.js";
import { buildAgentInstructions, buildLiveInstructions } from "../../envelope.js";
import { log } from "../../logger.js";
import type { CallState, PhoneProvider, ProviderCallOutcome, StartCallInput, StartCallResult, TranscriptTurn } from "../../types.js";
import { TwilioClient } from "../xai/twilio.js";
import { OpenAiLiveSession, LIVE_TOOL_NAMES, backendInstructionsAddendum, type LiveWsLike } from "./live.js";

/**
 * OpenAiLiveProvider: outbound via Twilio Programmable Voice + Media Streams -> OpenAI GPT-Live (gpt-live-1).
 *
 *  1. startCall: POST /Calls.json  To={callee} From={TWILIO_FROM_NUMBER}
 *       Twiml=<Response><Connect><Stream url="wss://PUBLIC/webhooks/openai-live/media"><Parameter name="task_id" .../></Stream></Connect></Response>
 *       + StatusCallback (initiated ringing answered completed) + async AMD callback. One leg only; our call_id = Twilio CallSid.
 *  2. Twilio runs the TwiML when the callee answers and opens the Media Stream WebSocket to us. The `start` frame carries
 *     callSid + customParameters.task_id (deterministic correlation, no oldest-pending guess). We open the GPT-Live
 *     WebSocket, send session.start (envelope as instructions, mu-law 8k, Responses delegation with our tools) and relay
 *     audio both ways as raw base64 mu-law. Greeting is HELD: GPT-Live waits for the human by default; if the callee says
 *     nothing for OPENAI_LIVE_GREETING_WAIT_MS we prompt it to open.
 *  3. Tools run through Responses delegation (report_outcome / ask_owner / end_call / note_hold).
 *  4. Hangup is owned by this bridge, not the model (see closeCall): end_call from the backend, the agent's own goodbye
 *     sentence, or a callee goodbye followed by agent silence all start the same sequence: let one short goodbye finish
 *     (agent audio quiet), stop forwarding callee audio so the model cannot start another turn, give a pending
 *     report_outcome a moment to land, wait for Twilio to confirm playout (`mark`), hang up via Twilio AND finalize
 *     locally, so a lost callback cannot leave the call stuck in_progress. A callee who says something substantive
 *     while the goodbye is still playing cancels the close (barge-in); the next farewell starts it again.
 *  5. Twilio status callbacks drive ringing/answered/completed; async AMD marks voicemail. Stream stop, session close and
 *     getOutcome() reconcile against Twilio when callbacks go quiet. If OpenAI drops the session while Twilio is still
 *     up, the callee leg is hung up rather than left on a dead line until TimeLimit.
 *
 * Why not OpenAI Direct SIP: OpenAI's telephony guide states outbound SIP through POST /v1/live/sessions is not supported
 * (inbound-only accept/attach flow). Twilio-originated SIP into OpenAI would work but adds project webhooks + a second
 * leg; Media Streams is the documented outbound path and keeps Twilio as the single call-control surface.
 */

interface LiveCall {
  task_id: string;
  twilio_sid: string;
  input: StartCallInput;
  state: CallState;
  started_at: number;
  answered_at: number | null;
  /** When we asked Twilio to drop the callee leg (the phone call is over from here). */
  hangup_at: number | null;
  /** Set once the call record is final. Between hangup_at and ended_at the OpenAI session may linger to collect a late report_outcome. */
  ended_at: number | null;
  collecting: boolean;
  last_status_at: number;
  reconciling: boolean;
  human_answered: boolean | null;
  voicemail: boolean | null;
  error: string | null;
  session: OpenAiLiveSession | null;
  stream: { ws: MediaWsLike; streamSid: string } | null;
  turns: TranscriptTurn[];
  outcome: Record<string, unknown> | null;
  pendingQuestion: { id: string; question: string; options?: string[]; asked_at: string; resolve: (a: string | null) => void } | null;
  /** The most recent ask_owner whose hold timed out; a late answer within NEEDS_USER_LATE_ANSWER_SECONDS is still delivered. */
  lastQuestion: { id: string; question: string; asked_at: string; expired_at: number } | null;
  closing: { trigger: CloseTrigger; cancelled: boolean; done: Promise<void> } | null;
  closeCancels: number;
  /** Twilio `mark` echoes we are waiting for (name -> resolver). */
  marks: Map<string, () => void>;
  raw: Record<string, unknown>;
}

/** Twilio Media Streams WebSocket (server side). Structural so tests can fake it. */
export interface MediaWsLike {
  on(event: "message" | "close" | "error", cb: (...a: any[]) => void): unknown;
  send(data: string): void;
  close(): void;
}

/** What started the hangup sequence. */
export type CloseTrigger = "end_call" | "agent_farewell" | "human_farewell";

/**
 * Timing of the hangup sequence. Defaults come from config; tests shrink them. Only the first three and playoutWaitMs
 * are on the callee's clock (the tail they hear after the goodbye is ~goodbyeQuietMs + mark echo + Twilio API call);
 * the outcome windows run AFTER the Twilio leg is down.
 */
export interface CloseTiming {
  /** After the trigger, wait at most this long for the goodbye audio to begin (0 = hang up immediately, no drain). */
  goodbyeStartWaitMs: number;
  /** The goodbye counts as finished once no agent audio has arrived for this long. */
  goodbyeQuietMs: number;
  /** Hard cap on the goodbye itself. */
  goodbyeMaxMs: number;
  /** Wait for Twilio's `mark` echo (audio fully played) at most this long; 0 disables the mark. */
  playoutWaitMs: number;
  /** After hangup, with no report_outcome recorded yet, keep the OpenAI session open this long for one to arrive ... */
  outcomeWaitMs: number;
  /** ... or this long when a backend delegation is already in flight. */
  delegationWaitMs: number;
  /** How many times a callee barge-in may cancel the close before it becomes firm. */
  maxCancels: number;
}

export function defaultCloseTiming(): CloseTiming {
  return { goodbyeStartWaitMs: config.openaiLive.hangupDelayMs, goodbyeQuietMs: 500, goodbyeMaxMs: 8000, playoutWaitMs: 1500, outcomeWaitMs: 1500, delegationWaitMs: 5000, maxCancels: 2 };
}

export interface OpenAiLiveProviderDeps {
  twilio?: TwilioClient;
  wsFactory?: (url: string, headers: Record<string, string>) => LiveWsLike;
  now?: () => number;
  closeTiming?: Partial<CloseTiming>;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

export function mediaStreamUrl(publicBaseUrl: string): string {
  return publicBaseUrl.replace(/^http/, "ws") + "/webhooks/openai-live/media";
}

/** TwiML executed on the answered callee leg: bidirectional Media Stream back to this service. */
export function mediaStreamTwiml(opts: { publicBaseUrl: string; taskId: string }): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="${esc(mediaStreamUrl(opts.publicBaseUrl))}">` +
    `<Parameter name="task_id" value="${esc(opts.taskId)}"/></Stream></Connect></Response>`;
}

export function dialForm(opts: { to: string; from: string; taskId: string; maxDurationSeconds: number; publicBaseUrl: string; ringTimeoutSeconds: number }): Record<string, string> {
  return {
    To: opts.to,
    From: opts.from,
    Twiml: mediaStreamTwiml({ publicBaseUrl: opts.publicBaseUrl, taskId: opts.taskId }),
    StatusCallback: `${opts.publicBaseUrl}/webhooks/openai-live/twilio/status`,
    StatusCallbackEvent: "initiated ringing answered completed",
    StatusCallbackMethod: "POST",
    MachineDetection: "Enable",
    AsyncAmd: "true",
    AsyncAmdStatusCallback: `${opts.publicBaseUrl}/webhooks/openai-live/twilio/amd`,
    AsyncAmdStatusCallbackMethod: "POST",
    Timeout: String(opts.ringTimeoutSeconds),
    TimeLimit: String(opts.maxDurationSeconds),
  };
}

export class OpenAiLiveProvider implements PhoneProvider {
  readonly name = "openai_live" as const;
  private calls = new Map<string, LiveCall>(); // keyed by Twilio CallSid (our call_id)
  private twilio: TwilioClient;
  private now: () => number;
  private timing: CloseTiming;
  constructor(private deps: OpenAiLiveProviderDeps = {}) {
    this.twilio = deps.twilio ?? new TwilioClient();
    this.now = deps.now ?? (() => Date.now());
    this.timing = { ...defaultCloseTiming(), ...(deps.closeTiming ?? {}) };
  }

  static preflight(): string[] {
    const missing: string[] = [];
    if (!config.openaiLive.apiKey) missing.push("OPENAI_API_KEY");
    if (!config.twilio.accountSid) missing.push("TWILIO_ACCOUNT_SID");
    if (!config.twilio.authToken) missing.push("TWILIO_AUTH_TOKEN");
    if (!config.twilio.fromNumber) missing.push("TWILIO_FROM_NUMBER");
    if (!config.publicBaseUrl) missing.push("PUBLIC_BASE_URL");
    return missing;
  }

  async startCall(input: StartCallInput): Promise<StartCallResult> {
    const missing = OpenAiLiveProvider.preflight();
    if (missing.length) throw new Error(`openai_live provider not configured: missing ${missing.join(", ")}`);
    const form = dialForm({ to: input.phone_number, from: config.twilio.fromNumber, taskId: input.task_id, maxDurationSeconds: input.max_duration_seconds, publicBaseUrl: config.publicBaseUrl, ringTimeoutSeconds: config.openaiLive.ringTimeoutSeconds });
    const { sid, raw } = await this.twilio.createCall(form);
    log.info("twilio.dialed", { task_id: input.task_id, call_sid: sid, path: "media_streams", callee: input.phone_number });
    this.calls.set(sid, {
      task_id: input.task_id, twilio_sid: sid, input, state: "dialing", started_at: this.now(), answered_at: null, hangup_at: null, ended_at: null, collecting: false, last_status_at: this.now(), reconciling: false,
      human_answered: null, voicemail: null, error: null, session: null, stream: null, turns: [], outcome: null, pendingQuestion: null, lastQuestion: null,
      closing: null, closeCancels: 0, marks: new Map(),
      raw: { provider: "openai_live", twilio: raw, model: config.openaiLive.model, backend_model: config.openaiLive.backendModel },
    });
    return { call_id: sid, state: "dialing", raw };
  }

  /** Twilio status callback for the (single) callee leg. */
  handleTwilioStatus(form: Record<string, string>): void {
    const sid = form.CallSid ?? "";
    const c = this.calls.get(sid);
    if (!c) { log.warn("twilio.status.unknown_sid", { sid, provider: "openai_live" }); return; }
    c.last_status_at = this.now();
    const s = form.CallStatus;
    log.info("twilio.status", { task_id: c.task_id, provider: "openai_live", sid, status: s, duration: form.CallDuration });
    if (s === "completed" && form.CallDuration) c.raw.twilio_duration = Number(form.CallDuration);
    if (c.ended_at) return;
    // We hung up and are collecting a late report_outcome; the record is finalized when that window closes.
    if (c.collecting) return;
    if (s === "ringing") { if (c.state === "dialing") c.state = "ringing"; }
    else if (s === "in-progress" || s === "answered") this.markAnswered(c);
    else if (s === "busy") this.end(c, "failed", "busy");
    else if (s === "no-answer") this.end(c, "failed", "no_answer");
    else if (s === "failed") this.end(c, "failed", form.ErrorMessage ?? "failed");
    else if (s === "canceled") this.end(c, "cancelled", "cancelled");
    else if (s === "completed") {
      if (!c.answered_at) this.end(c, "failed", "no_answer");
      else this.end(c, "completed", c.error);
    }
  }

  /** Twilio async AMD: AnsweredBy = human | machine_start | machine_end_beep | machine_end_silence | machine_end_other | fax | unknown */
  handleTwilioAmd(form: Record<string, string>): void {
    const c = this.calls.get(form.CallSid ?? "");
    if (!c) return;
    const by = form.AnsweredBy ?? "unknown";
    c.raw.answered_by = by;
    if (by.startsWith("machine")) {
      c.voicemail = true; c.human_answered = false;
      c.session?.appendInstructions("voicemail", "This call reached voicemail, not a person. Leave one brief message now (who you are, who you are calling for, the purpose, a callback request), then delegate to the backend to record the outcome and end the call.");
    } else if (by === "human") { c.voicemail = false; c.human_answered = true; }
    log.info("twilio.amd", { task_id: c.task_id, provider: "openai_live", answered_by: by });
  }

  private markAnswered(c: LiveCall) {
    if (!c.answered_at) c.answered_at = this.now();
    c.human_answered ??= true;
    if (c.state !== "needs_user") c.state = "in_progress";
  }

  /**
   * Twilio Media Streams WebSocket (already upgraded by the HTTP layer). Frames: connected, start{streamSid,callSid,
   * customParameters}, media{payload,track}, stop, dtmf, mark. We answer with media{streamSid,payload} and clear{streamSid}.
   */
  attachMediaStream(ws: MediaWsLike): void {
    let call: LiveCall | null = null;
    ws.on("message", (data: unknown) => {
      let msg: any;
      try { msg = JSON.parse(String(data)); } catch { return; }
      switch (msg.event) {
        case "start": {
          const start = msg.start ?? {};
          const c = this.calls.get(String(start.callSid ?? "")) ?? [...this.calls.values()].find((x) => x.task_id === start.customParameters?.task_id);
          if (!c || c.ended_at || c.stream) { log.warn("openai_live.media.unknown_call", { call_sid: start.callSid, task_id: start.customParameters?.task_id }); ws.close(); return; }
          call = c;
          c.stream = { ws, streamSid: String(start.streamSid ?? "") };
          c.raw.stream_sid = c.stream.streamSid;
          c.raw.stream_started_at = new Date(this.now()).toISOString();
          this.markAnswered(c);
          this.openSession(c);
          break;
        }
        case "media":
          if (call && (msg.media?.track ?? "inbound") === "inbound" && typeof msg.media?.payload === "string") call.session?.appendAudio(msg.media.payload);
          break;
        case "dtmf":
          if (call) this.note(call, `[callee pressed ${String(msg.dtmf?.digit ?? "?")}]`);
          break;
        case "mark": {
          // Twilio has finished playing every media frame queued before this mark.
          const done = call?.marks.get(String(msg.mark?.name ?? ""));
          if (done) done();
          break;
        }
        case "stop":
          if (call) this.onStreamStopped(call);
          break;
        default:
          break;
      }
    });
    ws.on("close", () => { if (call) this.onStreamStopped(call); });
    ws.on("error", (e: Error) => { log.warn("openai_live.media.error", { error: String(e) }); if (call) this.onStreamStopped(call); });
  }

  /** The session owns the chronologically ordered transcript once it exists; before that, the call record does. */
  private turnsOf(c: LiveCall): TranscriptTurn[] { return c.session ? c.session.turns : c.turns; }
  private note(c: LiveCall, text: string) {
    if (c.session) c.session.noteSystem(text);
    else c.turns.push({ speaker: "system", text, at: new Date(this.now()).toISOString() });
  }

  private onStreamStopped(c: LiveCall) {
    if (!c.stream) return;
    log.info("openai_live.media.stopped", { task_id: c.task_id });
    c.stream = null;
    if (c.collecting) return; // expected after our own hangup; the session stays up for the outcome window
    c.session?.close();
    if (!c.ended_at) void this.reconcile(c);
  }

  private openSession(c: LiveCall) {
    const owner = c.input.envelope.identity.owner_name;
    // Two layers: short conversation prompt for the live model; full envelope + authority + tools for the backend.
    const instructions = buildLiveInstructions(c.input.envelope, { recipient_name: c.input.recipient_name, opening_instruction: c.input.opening_instruction });
    const backendInstructions = buildAgentInstructions(c.input.envelope, { recipient_name: c.input.recipient_name, opening_instruction: c.input.opening_instruction, realtime_hold_supported: true, hold_seconds: config.needsUserHoldSeconds, tools: [...LIVE_TOOL_NAMES] }) + "\n" + backendInstructionsAddendum(owner);
    const session = new OpenAiLiveSession({
      instructions, backendInstructions, ownerName: owner, voice: c.input.preferred_voice ?? config.openaiLive.voice,
      wsFactory: this.deps.wsFactory, greetingWaitMs: config.openaiLive.greetingWaitMs, now: this.now,
      openingLine: c.input.opening_instruction,
      farewellDetection: config.openaiLive.farewellHangup, farewellSilenceMs: config.openaiLive.farewellSilenceMs,
      hooks: {
        onAskOwner: (question, options) => this.holdForOwner(c, question, options),
        onEndCall: (reason) => this.closeCall(c, "end_call", reason),
      },
    });
    session.on("audio", (b64: string) => { if (c.stream) c.stream.ws.send(JSON.stringify({ event: "media", streamSid: c.stream.streamSid, media: { payload: b64 } })); });
    session.on("barge_in", () => { if (config.openaiLive.clearOnBargeIn && c.stream) c.stream.ws.send(JSON.stringify({ event: "clear", streamSid: c.stream.streamSid })); });
    // Farewell intent -> hangup sequence. The agent's goodbye starts it directly; a callee goodbye only starts it once
    // the agent has stayed silent (its own goodbye, if it comes first, is the normal path).
    session.on("farewell", (speaker: "assistant" | "human") => { if (speaker === "assistant") void this.closeCall(c, "agent_farewell", "agent_said_goodbye"); });
    // On voicemail the "callee" is a recording; its sign-off must not cut the message the agent is about to leave.
    session.on("farewell_silence", () => { if (!c.voicemail) void this.closeCall(c, "human_farewell", "callee_said_goodbye"); });
    session.on("human_utterance", (_text: string, kind: string) => { if (kind === "substantive") this.cancelCloseOnBargeIn(c); });
    // Anything noted before the session existed (rare: pre-answer events) is carried over; from here the session's ordered list is the transcript.
    for (const t of c.turns) session.noteSystem(t.text);
    session.on("outcome", (o: Record<string, unknown>) => { c.outcome = o; });
    session.on("started", (id: string | null) => { c.raw.openai_session_id = id; });
    session.on("greeting_fallback", () => { c.raw.greeting_fallback = true; log.info("openai_live.greeting_fallback", { task_id: c.task_id, note: "callee did not speak after pickup; agent opened" }); });
    session.on("error", (e: Error) => { c.raw.live_error = String(e); });
    session.on("stale_result", (tool: string) => { c.raw.stale_results = [...((c.raw.stale_results as string[] | undefined) ?? []), tool]; });
    session.on("closed", (info: { session_reason: string | null }) => {
      c.raw.live_close_reason = info.session_reason;
      if (c.ended_at || c.collecting) return; // collecting: the close sequence finalizes as soon as it sees session.closed
      if (!session.wasCloseRequested && c.stream) {
        // OpenAI dropped the session (expired, connection_lost, server error) while the callee is still connected.
        // Twilio would keep the leg up until TimeLimit with dead air; hang up now and finalize.
        log.warn("openai_live.session_dropped", { task_id: c.task_id, reason: info.session_reason });
        void this.hangupNow(c, c.outcome ? "completed" : "failed", c.outcome ? null : `live_session_closed:${info.session_reason ?? "unknown"}`);
        return;
      }
      log.info("openai_live.session_closed_before_twilio_end", { task_id: c.task_id, reason: info.session_reason });
      void this.reconcile(c);
    });
    c.session = session;
    session.connect();
    log.info("openai_live.session_attached", { task_id: c.task_id, twilio_sid: c.twilio_sid });
  }

  /**
   * Hangup sequence (idempotent; the first trigger wins, later ones only refine end_reason):
   *   goodbye  -> wait for the agent's goodbye audio to start (<= goodbyeStartWaitMs) and finish (goodbyeQuietMs of silence)
   *   done     -> mute callee audio so the model cannot start another turn
   *   playout  -> Twilio `mark` echo confirms the goodbye actually played (not just left our socket)
   *   hangup   -> Twilio hangup: the callee's call is over here, ~goodbyeQuietMs + playout after the last goodbye audio
   *   collect  -> (callee already gone) if no report_outcome was recorded, keep the OpenAI session open a moment for the
   *               backend to deliver it, then finalize the record and close the session
   * Returns when the record is final or the close was cancelled by a barge-in.
   */
  private closeCall(c: LiveCall, trigger: CloseTrigger, reason: string): Promise<void> {
    if (trigger === "end_call") c.raw.end_reason = reason;
    if (c.ended_at) return Promise.resolve();
    if (c.closing) return c.closing.done;
    const closing = { trigger, cancelled: false, done: Promise.resolve() };
    closing.done = this.runClose(c, closing, reason).catch((e) => { log.error("openai_live.close_failed", { task_id: c.task_id, error: String(e) }); });
    c.closing = closing;
    return closing.done;
  }

  private async runClose(c: LiveCall, closing: NonNullable<LiveCall["closing"]>, reason: string): Promise<void> {
    const t = this.timing;
    const s = c.session;
    const t0 = this.now();
    const poll = Math.max(10, Math.min(100, Math.floor(t.goodbyeQuietMs / 4)));
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    c.raw.close_trigger = closing.trigger;
    c.raw.end_reason ??= reason;
    log.info("openai_live.closing", { task_id: c.task_id, trigger: closing.trigger, reason, outcome_recorded: !!c.outcome });

    // Stage "goodbye": one short farewell may play; a substantive callee interruption cancels (see cancelCloseOnBargeIn).
    // After a callee goodbye + agent silence there is nothing to wait for unless the agent is speaking right now.
    if (s && t.goodbyeStartWaitMs > 0) {
      s.closingStage = "goodbye";
      const startWait = closing.trigger === "human_farewell" ? 0 : t.goodbyeStartWaitMs;
      let spoke = s.lastAgentAudioAtMs > 0 && t0 - s.lastAgentAudioAtMs < t.goodbyeQuietMs;
      for (;;) {
        if (c.ended_at || closing.cancelled) return;
        const n = this.now();
        if (s.lastAgentAudioAtMs >= t0) spoke = true;
        if (spoke && n - s.lastAgentAudioAtMs >= t.goodbyeQuietMs) break;
        if (!spoke && n - t0 >= startWait) break;
        if (n - t0 >= t.goodbyeMaxMs) break;
        await sleep(poll);
      }
      if (closing.trigger === "agent_farewell" && !s.agentIsClosing()) {
        // Early match on a sentence that turned out not to be a goodbye ("...before we say goodbye, which day?").
        log.info("openai_live.close_abandoned", { task_id: c.task_id, last_agent_text: s.currentAssistantText().slice(-120) });
        s.resetClosing();
        c.closing = null;
        return;
      }
    }
    if (c.ended_at || closing.cancelled) return;

    // Stage "done": the goodbye has been said. Nothing else may be spoken; no more callee audio reaches the model.
    if (s) { s.closingStage = "done"; s.muteInput(); }
    c.raw.goodbye_done_ms = this.now() - t0;

    // Stage "playout": our socket being quiet is not the callee having heard it; Twilio echoes the mark after playback.
    if (c.stream && t.playoutWaitMs > 0) {
      const name = `hangup_${this.now()}`;
      const stream = c.stream;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, t.playoutWaitMs);
        c.marks.set(name, () => { clearTimeout(timer); resolve(); });
        try { stream.ws.send(JSON.stringify({ event: "mark", streamSid: stream.streamSid, mark: { name } })); } catch { clearTimeout(timer); resolve(); }
      });
      c.marks.delete(name);
    }
    if (c.ended_at) return;

    // Stage "hangup": the callee's call ends here. Nothing below adds to what they hear.
    c.hangup_at = this.now();
    c.raw.hangup_at = new Date(c.hangup_at).toISOString();
    c.raw.close_ms = c.hangup_at - t0;
    log.info("openai_live.hangup", { task_id: c.task_id, trigger: closing.trigger, close_ms: c.raw.close_ms, tail_after_goodbye_ms: c.hangup_at - t0 - (c.raw.goodbye_done_ms as number) + t.goodbyeQuietMs, outcome_recorded: !!c.outcome });
    // Closing the Media Stream socket ends the <Connect><Stream> call on Twilio's side at once (nothing follows it in
    // the TwiML); the REST hangup runs in parallel as the authoritative fallback.
    const stream = c.stream;
    c.stream = null;
    try { stream?.ws.close(); } catch { /* ignore */ }
    await this.twilio.hangup(c.twilio_sid).catch((e) => log.warn("twilio.hangup_failed", { error: String(e) }));
    if (c.ended_at) return;

    // Stage "collect": with the callee gone, give the backend a moment to deliver report_outcome (longer if it is
    // already working on it) so the structured result is not lost when the live model closed on its own.
    if (s && !c.outcome && !s.closed) {
      c.collecting = true;
      const tb = this.now();
      try {
        while (!c.outcome && !c.ended_at && !s.closed) {
          if (this.now() - tb >= (s.hasDelegationInFlight ? t.delegationWaitMs : t.outcomeWaitMs)) break;
          await sleep(poll);
        }
        c.raw.collect_ms = this.now() - tb;
        if (!c.outcome) log.info("openai_live.collect_timeout", { task_id: c.task_id, delegation_in_flight: s.hasDelegationInFlight });
      } finally { c.collecting = false; }
    }
    this.end(c, "completed", null);
  }

  /**
   * Callee barge-in while the goodbye is still playing: they have more to say, so the conversation continues. Only
   * when farewell detection is on: that is what closes the call again afterwards (the backend never repeats end_call).
   */
  private cancelCloseOnBargeIn(c: LiveCall) {
    const s = c.session;
    if (!config.openaiLive.farewellHangup || !c.closing || c.closing.cancelled || !s || s.closingStage !== "goodbye") return;
    if (c.closeCancels >= this.timing.maxCancels) { log.info("openai_live.close_firm", { task_id: c.task_id, cancels: c.closeCancels }); return; }
    c.closeCancels++;
    c.closing.cancelled = true;
    c.closing = null;
    s.resetClosing();
    c.raw.close_cancels = c.closeCancels;
    log.info("openai_live.close_cancelled", { task_id: c.task_id, cancels: c.closeCancels, note: "callee kept talking during the goodbye" });
  }

  private async hangupNow(c: LiveCall, state: CallState, error: string | null) {
    if (c.ended_at) return;
    await this.twilio.hangup(c.twilio_sid).catch((e) => log.warn("twilio.hangup_failed", { error: String(e) }));
    this.end(c, state, error);
  }

  private holdForOwner(c: LiveCall, question: string, options?: string[]): Promise<string | null> {
    return new Promise((resolve) => {
      const id = `q_${this.now()}`;
      // Leaving needs_user must not overwrite a final state if the call ended while holding.
      const release = () => { c.pendingQuestion = null; if (!c.ended_at) c.state = "in_progress"; };
      const asked_at = new Date(this.now()).toISOString();
      const timer = setTimeout(() => {
        if (c.pendingQuestion?.id !== id) return;
        // Brian may still be typing: remember the question so a late answer can be handed to the agent mid-call.
        c.lastQuestion = { id, question, asked_at, expired_at: this.now() };
        log.info("openai_live.needs_user_timeout", { task_id: c.task_id, question_id: id, late_answer_window_s: config.needsUserLateAnswerSeconds });
        release(); resolve(null);
      }, config.needsUserHoldSeconds * 1000);
      c.pendingQuestion = { id, question, options, asked_at, resolve: (a) => { clearTimeout(timer); release(); resolve(a); } };
      c.state = "needs_user";
      log.info("openai_live.needs_user", { task_id: c.task_id, question, options, hold_seconds: config.needsUserHoldSeconds });
    });
  }

  async answerQuestion(call_id: string, question_id: string, answer: string) {
    const c = this.calls.get(call_id);
    if (!c) return { delivered: false, message: "unknown call" };
    if (c.pendingQuestion) {
      if (question_id && c.pendingQuestion.id !== question_id) return { delivered: false, message: "question id mismatch (stale)" };
      c.pendingQuestion.resolve(answer);
      return { delivered: true };
    }
    if (c.ended_at || c.hangup_at) return { delivered: false, message: "call already ended" };
    // The hold timed out before Brian's reply came through chat. If the question is recent and the call is still live,
    // hand the answer to the live model directly (same mid-call instruction path as the greeting fallback) instead of
    // letting the agent finish on a callback request.
    const late = c.lastQuestion;
    const s = c.session;
    if (late && s?.started && !s.closed && s.closingStage === "none" && this.now() - late.expired_at <= config.needsUserLateAnswerSeconds * 1000) {
      if (question_id && late.id !== question_id) return { delivered: false, message: "question id mismatch (stale)" };
      const owner = c.input.envelope.identity.owner_name;
      s.appendInstructions(`owner_late_answer_${late.id}`, `${owner} has now answered the question you asked earlier ("${late.question}"): "${answer}". Use this answer now: tell the person, and continue the call with it. Do not ask for a callback for this any more.`);
      s.appendCommentary(`owner_late_answer_go_${late.id}`, `Relay ${owner}'s answer to the person now.`);
      s.noteSystem(`[owner answered after the hold: ${answer}]`);
      c.lastQuestion = null;
      c.raw.late_answers = ((c.raw.late_answers as number | undefined) ?? 0) + 1;
      log.info("openai_live.late_answer_delivered", { task_id: c.task_id, question_id: late.id, seconds_after_timeout: Math.round((this.now() - late.expired_at) / 1000) });
      return { delivered: true, message: "hold had timed out; answer handed to the agent mid-call" };
    }
    return { delivered: false, message: late ? "question too old (late-answer window passed)" : "no pending question" };
  }

  private end(c: LiveCall, state: CallState, error: string | null) {
    if (c.ended_at) return;
    c.ended_at = this.now();
    c.state = state;
    c.error = error;
    c.pendingQuestion?.resolve(null);
    c.session?.close();
    if (c.stream) { try { c.stream.ws.close(); } catch { /* ignore */ } c.stream = null; }
    log.info("openai_live.call_ended", { task_id: c.task_id, state, error });
  }

  private async reconcile(c: LiveCall): Promise<void> {
    if (c.ended_at || c.reconciling) return;
    c.reconciling = true;
    try {
      const t = await this.twilio.fetch(c.twilio_sid).catch(() => null);
      const status = String(t?.status ?? "");
      log.info("twilio.reconcile", { task_id: c.task_id, provider: "openai_live", sid: c.twilio_sid, status });
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
    if (!c) throw new Error(`openai_live: unknown call ${call_id}`);
    if (!c.ended_at && !c.collecting) {
      const quiet = this.now() - c.last_status_at > config.twilio.reconcileAfterMs;
      const overMax = this.now() - c.started_at > (c.input.max_duration_seconds + 60) * 1000;
      if (c.session?.closed || quiet || overMax) await this.reconcile(c);
    }
    const ended = !!c.ended_at;
    const twilioDuration = typeof c.raw.twilio_duration === "number" ? (c.raw.twilio_duration as number) : null;
    const duration = ended && twilioDuration != null ? twilioDuration : c.answered_at ? Math.round(((c.hangup_at ?? c.ended_at ?? this.now()) - c.answered_at) / 1000) : null;
    const turns = this.turnsOf(c);
    const transcript = turns.map((t) => `${t.speaker}: ${t.text}`).join("\n");
    const usage = c.session?.usageSeconds ?? null;
    return {
      call_id, ended, state: c.state,
      human_answered: ended ? (c.human_answered ?? turns.some((t) => t.speaker === "human")) : c.human_answered,
      voicemail: ended ? (c.voicemail ?? false) : c.voicemail,
      duration_seconds: duration, transcript, transcript_turns: turns,
      recording_reference: config.openaiLive.store && c.session?.sessionId ? `openai-live://sessions/${c.session.sessionId}/content` : null,
      error: c.error ?? (ended && turns.length === 0 && !c.voicemail ? "no_transcript" : null),
      // Voice layer is billed at $0.05/min per OpenAI's launch pricing; backend tokens and Twilio minutes are extra.
      cost_usd: usage != null ? Number(((usage / 60) * 0.05).toFixed(4)) : null,
      provider_extraction: c.outcome ? (c.outcome as ProviderCallOutcome["provider_extraction"]) : null,
      raw: {
        ...c.raw, provider: "openai_live", twilio_sid: c.twilio_sid,
        answered_at: c.answered_at ? new Date(c.answered_at).toISOString() : null, ended_at: c.ended_at ? new Date(c.ended_at).toISOString() : null,
        live_usage_seconds: usage, latency: c.session?.latency ?? null,
        pending_question: c.pendingQuestion ? { id: c.pendingQuestion.id, question: c.pendingQuestion.question, options: c.pendingQuestion.options, asked_at: c.pendingQuestion.asked_at } : null,
        last_question: c.lastQuestion ? { id: c.lastQuestion.id, question: c.lastQuestion.question, asked_at: c.lastQuestion.asked_at, expired_at: new Date(c.lastQuestion.expired_at).toISOString() } : null,
      },
    };
  }

  async cancelCall(call_id: string) {
    const c = this.calls.get(call_id);
    if (!c) return { cancelled: false, message: "unknown call" };
    if (c.ended_at || c.hangup_at) return { cancelled: false, message: "already ended" };
    const r = await this.twilio.hangup(c.twilio_sid);
    if (r.ok) this.end(c, "cancelled", "cancelled");
    return { cancelled: r.ok };
  }
}
