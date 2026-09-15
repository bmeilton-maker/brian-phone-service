import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { config } from "../../config.js";
import { log } from "../../logger.js";
import { RESULT_JSON_SCHEMA } from "../../extraction.js";
import type { TranscriptTurn } from "../../types.js";

/**
 * One OpenAI GPT-Live session (model gpt-live-1) bridged to a Twilio Media Stream.
 *
 * Two layers, per OpenAI's GPT-Live guides: the live model only conducts the conversation (short prompt from
 * buildLiveInstructions: role, style, when to delegate); the Responses backend holds the full envelope, authority,
 * required outputs and the tools (report_outcome / ask_owner / end_call / note_hold). This process owns permissions,
 * the needs_user hold, hangup and the durable call record; backend results are checked for staleness before they
 * are fed back to the live model.
 *
 * Verified against developers.openai.com (Sept 2026: WebSockets, Managing sessions, Delegation and tools, Telephony):
 *   connect  wss://api.openai.com/v1/live/sessions   Authorization: Bearer OPENAI_API_KEY, User-Agent
 *   ->  session.start { session: { model, instructions, audio:{format:{type:"audio/pcmu",rate:8000}, output:{voice}}, delegation } }
 *   <-  session.started { session:{ id } }                           (only then send audio / commands)
 *   ->  session.input_audio.append { audio: base64 }                 (Twilio inbound mu-law, forwarded as is)
 *   <-  session.output_audio.delta { delta: base64 }                 (forwarded to Twilio as is)
 *   <-  session.input_transcript.delta / session.output_transcript.delta { delta, start_ms, end_ms }  (fragments, not turns)
 *   <-  session.delegation.created { delegation:{ id, target:"responses" }, response_id }
 *   <-  response.event { delegation_id, event:{ type:"response.output_item.done", item:{ type:"function_call", call_id, name, arguments, status } } }
 *   ->  response.item.create { item:{ type:"function_call_output", call_id, output } }  then  response.create
 *   ->  session.instructions.append / session.commentary.append { delegation_id:null, content }   (greeting fallback)
 *   ->  session.close   <-  session.closed { reason, usage:{ seconds } }
 *   <-  session.usage.updated { usage:{ seconds } }, error { error:{ code, message, client_event_id } }
 *
 * GPT-Live is full duplex and owns turn-taking: there is no VAD config, no response.create-to-speak loop, and no
 * output-audio-done event. Interruptions are handled by the model; we optionally `clear` Twilio's playout buffer.
 */

/** Slim tool set. send_dtmf is omitted: Media Streams cannot inject DTMF into the call. */
export const LIVE_TOOL_NAMES = ["report_outcome", "ask_owner", "end_call", "note_hold"] as const;

export function backendTools(ownerName: string) {
  return [
    { type: "function", name: "report_outcome", description: `Record the structured outcome of the call for ${ownerName}. Call this once, right before the assistant says goodbye, or as soon as the call clearly cannot proceed.`, parameters: RESULT_JSON_SCHEMA },
    { type: "function", name: "ask_owner", description: `Ask ${ownerName} a question the assistant cannot answer from its instructions or authority. Returns ${ownerName}'s answer, or "NO_ANSWER" if they did not respond in time.`,
      parameters: { type: "object", additionalProperties: false, required: ["question"], properties: { question: { type: "string" }, options: { type: "array", items: { type: "string" } } } } },
    { type: "function", name: "end_call", description: "Hang up the phone call. Only after the assistant has said goodbye and report_outcome has been called.", parameters: { type: "object", additionalProperties: false, required: ["reason"], properties: { reason: { type: "string", enum: ["objective_complete", "voicemail_left", "wrong_number", "cannot_complete", "needs_owner", "hold_too_long", "other"] } } } },
    { type: "function", name: "note_hold", description: "Record that the assistant has been placed on hold or hears hold music/silence.", parameters: { type: "object", additionalProperties: false, required: ["note"], properties: { note: { type: "string" } } } },
  ];
}

/**
 * Backend (Responses delegation) prompt addendum. The backend gets the FULL envelope from buildAgentInstructions
 * (objective, context, authority, required outputs, tool note) plus this: how to serve the live model.
 */
export function backendInstructionsAddendum(ownerName: string): string {
  return `
VOICE CONVERSATION CONTEXT
You are the back office for the voice assistant speaking on a live phone call for ${ownerName}. The voice model handles the conversation and delegates to you; you receive the conversation so far. Transcripts can contain mistakes, unfinished phrases and later corrections: use the latest confirmed information. Reply with one or two short sentences the assistant can say aloud.

WHAT TO DO
- Fact, preference or choice question (a detail about ${ownerName}, which offered option fits, what still needs to be found out): answer in one sentence from RELEVANT CONTEXT, PREFERENCES and REQUIRED OUTPUTS above. If the context does not have it, say so plainly; the assistant must not invent it.
- Authority question (may the assistant agree to something, or disclose something): answer from AUTHORITY above in one sentence. Anything not listed as YES is NO; then the assistant must say it needs to check with ${ownerName}.
- ${ownerName}'s decision needed: call ask_owner with a crisp question and the options, then relay the answer in one sentence. If the answer is NO_ANSWER, tell the assistant to take the best callback number and any reference number, thank the person and end the call.
- Record the outcome / end the call (objective done, cannot proceed, voicemail left, wrong number, goodbye said): call report_outcome with everything learned (status success only if the objective and required outputs were achieved without any unauthorized commitment), then call end_call with the matching reason.
- On hold: call note_hold.
- Stale or repeated requests: if the person changed or withdrew a request, act on the latest one and ignore the earlier result. Never repeat report_outcome or end_call once they have been called. Never invent facts, confirmation numbers or commitments.`;
}

export interface LiveHooks {
  onAskOwner(question: string, options?: string[]): Promise<string | null>;
  onEndCall(reason: string): Promise<void>;
}

export interface LiveWsLike {
  on(event: "open" | "message" | "close" | "error", cb: (...a: any[]) => void): unknown;
  send(data: string): void;
  close(): void;
}

export interface LiveLatency {
  /** ms from connect() to session.started */
  session_started_ms: number | null;
  /** ms from session.started to first human transcript fragment */
  first_human_transcript_ms: number | null;
  /** ms from session.started to first agent audio */
  first_agent_audio_ms: number | null;
  /** Approximate human-stops -> agent-starts gaps (transcript-arrival based; GPT-Live has no turn events). */
  turn_latencies_ms: number[];
  /** Backend round trips: session.delegation.created -> nested response.completed */
  delegation_roundtrips_ms: number[];
  greeting_fallback: boolean;
}

export interface LiveSessionOptions {
  instructions: string;
  backendInstructions: string;
  ownerName: string;
  voice: string;
  hooks: LiveHooks;
  wsFactory?: (url: string, headers: Record<string, string>) => LiveWsLike;
  greetingWaitMs?: number;
  /** Text spoken if the callee picks up and says nothing (greeting fallback). Default: a purpose-only opener, no AI identity. */
  openingLine?: string;
  now?: () => number;
}

const USER_AGENT = "brian-phone-service/Node 0.1.0";
const TURN_FLUSH_MS = 1200;
const TURN_GAP_MS = 1500;
const TURN_OVERLAP_TOLERANCE_MS = 300;
const AGENT_SILENCE_GAP_MS = 500;

export class OpenAiLiveSession extends EventEmitter {
  readonly turns: TranscriptTurn[] = [];
  outcome: Record<string, unknown> | null = null;
  sessionId: string | null = null;
  closeReason: string | null = null;
  usageSeconds: number | null = null;
  readonly latency: LiveLatency = { session_started_ms: null, first_human_transcript_ms: null, first_agent_audio_ms: null, turn_latencies_ms: [], delegation_roundtrips_ms: [], greeting_fallback: false };
  started = false;
  closed = false;

  private ws: LiveWsLike | null = null;
  private now: () => number;
  private connectedAt = 0;
  private startedAt = 0;
  private humanSpoke = false;
  private greeted = false;
  private greetingTimer: NodeJS.Timeout | null = null;
  private closeTimer: NodeJS.Timeout | null = null;
  private closeRequested = false;
  private handledCalls = new Set<string>();
  private buffers: Record<"human" | "assistant", { text: string; startedAt: number; lastEndMs: number; timer: NodeJS.Timeout | null }> = {
    human: { text: "", startedAt: 0, lastEndMs: -1, timer: null },
    assistant: { text: "", startedAt: 0, lastEndMs: -1, timer: null },
  };
  private lastHumanTranscriptAt = 0;
  private lastAgentAudioAt = 0;
  private agentTurnStartedAt = 0;
  private delegations = new Map<string, number>();

  constructor(private opts: LiveSessionOptions) {
    super();
    this.now = opts.now ?? (() => Date.now());
  }

  connect(): void {
    const headers = { Authorization: `Bearer ${config.openaiLive.apiKey}`, "User-Agent": USER_AGENT };
    const factory = this.opts.wsFactory ?? ((u, h) => new WebSocket(u, { headers: h }) as unknown as LiveWsLike);
    this.connectedAt = this.now();
    this.ws = factory(config.openaiLive.wsUrl, headers);
    this.ws.on("open", () => {
      log.info("openai_live.ws.open", {});
      this.send({ type: "session.start", event_id: "session_start", session: this.sessionConfig() });
    });
    this.ws.on("message", (data: unknown) => { void this.handle(String(data)); });
    this.ws.on("close", (code: number, reason: unknown) => { this.closed = true; this.clearTimers(); this.flushAll(); this.emit("closed", { code, reason: String(reason ?? ""), session_reason: this.closeReason }); });
    this.ws.on("error", (e: Error) => { log.error("openai_live.ws.error", { error: String(e) }); this.emit("error", e); });
  }

  sessionConfig(): Record<string, unknown> {
    const responses: Record<string, unknown> = { model: config.openaiLive.backendModel, instructions: this.opts.backendInstructions, tools: backendTools(this.opts.ownerName), tool_choice: "auto", parallel_tool_calls: false };
    if (config.openaiLive.backendReasoningEffort) responses.reasoning = { effort: config.openaiLive.backendReasoningEffort };
    if (config.openaiLive.backendServiceTier) responses.service_tier = config.openaiLive.backendServiceTier;
    return {
      model: config.openaiLive.model,
      instructions: this.opts.instructions,
      audio: { format: { type: "audio/pcmu", rate: 8000 }, output: { voice: this.opts.voice } },
      delegation: { type: "responses", responses },
      ...(config.openaiLive.store ? { store: true } : {}),
    };
  }

  /** Twilio inbound mu-law frame (base64). Dropped until session.started, as the docs require. */
  appendAudio(b64: string): void {
    if (!this.started || this.closed || this.closeRequested) return;
    this.send({ type: "session.input_audio.append", audio: b64 });
  }

  /** Record an application-side event (e.g. callee key press) in the transcript in chronological order. */
  noteSystem(text: string): void { this.pushTurn({ speaker: "system", text }); }

  /** Session-wide instruction mid-call (e.g. voicemail detected). No-op before session.started. */
  appendInstructions(eventId: string, content: string): void {
    if (!this.started || this.closed || this.closeRequested) return;
    this.send({ type: "session.instructions.append", event_id: eventId, delegation_id: null, content });
  }

  /** Graceful close: session.close, wait for session.closed (<= 5 s), then drop the socket. */
  close(): void {
    if (this.closed) return;
    if (this.closeRequested) return;
    if (this.greetingTimer) { clearTimeout(this.greetingTimer); this.greetingTimer = null; }
    if (!this.started) { this.closeRequested = true; this.ws?.close(); return; }
    this.send({ type: "session.close", event_id: "session_close" });
    this.closeRequested = true;
    this.closeTimer = setTimeout(() => { this.closeTimer = null; if (!this.closed) { log.warn("openai_live.close_timeout", { session_id: this.sessionId }); this.ws?.close(); } }, 5000);
    this.closeTimer.unref?.();
  }

  private clearTimers() {
    if (this.greetingTimer) clearTimeout(this.greetingTimer);
    if (this.closeTimer) clearTimeout(this.closeTimer);
    for (const b of Object.values(this.buffers)) if (b.timer) clearTimeout(b.timer);
    this.greetingTimer = this.closeTimer = null;
  }

  private send(msg: Record<string, unknown>) {
    // After session.close only the close itself may go out; the docs reject further commands anyway.
    if (this.closed || (this.closeRequested && msg.type !== "session.close")) return;
    this.ws?.send(JSON.stringify(msg));
  }

  /** Greeting policy: silence on pickup; if nobody says hello within greetingWaitMs, open anyway. */
  private armGreetingWait() {
    if (this.humanSpoke || this.greeted) return;
    this.greetingTimer = setTimeout(() => {
      this.greetingTimer = null;
      if (this.humanSpoke || this.greeted || this.closed) return;
      this.greeted = true;
      this.latency.greeting_fallback = true;
      const opening = this.opts.openingLine
        ? `say "${this.opts.openingLine}" in one short sentence`
        : "open with one short, purpose-only sentence about why you are calling (do not say who or what you are)";
      this.send({ type: "session.instructions.append", event_id: "greeting_fallback", delegation_id: null,
        content: `The person has picked up but has not said anything. Speak first now, in English: ${opening}, then pause and listen for their reply.` });
      this.send({ type: "session.commentary.append", event_id: "greeting_fallback_go", delegation_id: null, content: "Begin the conversation now, following the instructions provided." });
      this.emit("greeting_fallback");
    }, this.opts.greetingWaitMs ?? 3000);
    this.greetingTimer.unref?.();
  }

  /** Public for tests: feed one raw server event. */
  async handle(raw: string): Promise<void> {
    let ev: any;
    try { ev = JSON.parse(raw); } catch { return; }
    switch (ev.type) {
      case "session.started":
        this.started = true;
        this.startedAt = this.now();
        this.sessionId = ev.session?.id ?? null;
        this.latency.session_started_ms = this.startedAt - this.connectedAt;
        log.info("openai_live.session.started", { session_id: this.sessionId, ms: this.latency.session_started_ms });
        this.emit("started", this.sessionId);
        this.armGreetingWait();
        break;
      case "session.output_audio.delta": {
        const t = this.now();
        if (this.latency.first_agent_audio_ms === null) this.latency.first_agent_audio_ms = t - this.startedAt;
        if (t - this.lastAgentAudioAt > AGENT_SILENCE_GAP_MS) {
          // Agent starts a new stretch of speech. If the human spoke since the agent's previous stretch began,
          // record the gap as an approximate turn latency (transcript arrival lags audio slightly).
          if (this.lastHumanTranscriptAt > this.agentTurnStartedAt && t - this.lastHumanTranscriptAt < 15_000) this.latency.turn_latencies_ms.push(t - this.lastHumanTranscriptAt);
          this.agentTurnStartedAt = t;
        }
        this.lastAgentAudioAt = t;
        this.greeted = true;
        if (typeof ev.delta === "string" && ev.delta) this.emit("audio", ev.delta);
        break;
      }
      case "session.input_transcript.delta": {
        const t = this.now();
        if (this.latency.first_human_transcript_ms === null) this.latency.first_human_transcript_ms = t - this.startedAt;
        this.lastHumanTranscriptAt = t;
        if (!this.humanSpoke) {
          this.humanSpoke = true;
          if (this.greetingTimer) { clearTimeout(this.greetingTimer); this.greetingTimer = null; }
          this.emit("human_speech");
        }
        // Barge-in signal for the bridge: human talking while agent audio was flowing recently.
        if (t - this.lastAgentAudioAt < AGENT_SILENCE_GAP_MS && this.buffers.human.text === "") this.emit("barge_in");
        this.bufferTranscript("human", String(ev.delta ?? ""), ev.start_ms, ev.end_ms);
        break;
      }
      case "session.output_transcript.delta":
        this.greeted = true;
        this.bufferTranscript("assistant", String(ev.delta ?? ""), ev.start_ms, ev.end_ms);
        break;
      case "session.delegation.created": {
        const id = String(ev.delegation?.id ?? ev.delegation_id ?? "");
        if (id) this.delegations.set(id, this.now());
        log.info("openai_live.delegation", { session_id: this.sessionId, delegation_id: id, target: ev.delegation?.target, response_id: ev.response_id });
        this.emit("delegation", id);
        break;
      }
      case "response.event": {
        const inner = ev.event ?? {};
        if (inner.type === "response.output_item.done" && inner.item?.type === "function_call" && (inner.item.status ?? "completed") === "completed") {
          await this.dispatchTool(String(inner.item.name ?? ""), String(inner.item.call_id ?? ""), inner.item.arguments);
        } else if (inner.type === "response.completed" || inner.type === "response.failed" || inner.type === "response.incomplete") {
          const startedAt = this.delegations.get(String(ev.delegation_id ?? ""));
          if (startedAt) { this.latency.delegation_roundtrips_ms.push(this.now() - startedAt); this.delegations.delete(String(ev.delegation_id)); }
          if (inner.type !== "response.completed") log.warn("openai_live.backend_response", { type: inner.type, error: inner.response?.error ?? null });
        }
        break;
      }
      case "session.instructions.appended":
      case "session.commentary.appended":
      case "session.thinking.appended":
        log.debug("openai_live.appended", { type: ev.type, client_event_id: ev.client_event_id });
        break;
      case "session.usage.updated":
        if (typeof ev.usage?.seconds === "number") this.usageSeconds = ev.usage.seconds;
        break;
      case "session.closed":
        this.closeReason = String(ev.reason ?? "");
        if (typeof ev.usage?.seconds === "number") this.usageSeconds = ev.usage.seconds;
        log.info("openai_live.session.closed", { session_id: this.sessionId, reason: this.closeReason, usage_seconds: this.usageSeconds });
        if (this.closeTimer) { clearTimeout(this.closeTimer); this.closeTimer = null; }
        this.flushAll();
        this.ws?.close();
        break;
      case "error":
        log.error("openai_live.server_error", { error: ev.error ?? ev });
        this.emit("error", new Error(JSON.stringify(ev.error ?? ev)));
        break;
      default:
        break;
    }
  }

  /**
   * Transcript fragments have no turn boundaries. Group per speaker using the session timeline (start_ms/end_ms):
   * a fragment closes the other speaker's turn once it starts clearly after that turn's last fragment ended (so a
   * short backchannel during the other's speech does not split it), and a long same-speaker gap starts a new turn.
   * A wall-clock idle timer flushes the tail.
   */
  private bufferTranscript(speaker: "human" | "assistant", delta: string, startMs?: number, endMs?: number) {
    if (!delta) return;
    const other = speaker === "human" ? "assistant" : "human";
    const o = this.buffers[other];
    const b = this.buffers[speaker];
    if (typeof startMs === "number") {
      if (o.text && o.lastEndMs >= 0 && o.lastEndMs + TURN_OVERLAP_TOLERANCE_MS < startMs) this.flush(other);
      if (b.text && b.lastEndMs >= 0 && startMs > b.lastEndMs + TURN_GAP_MS) this.flush(speaker);
    }
    const t = this.now();
    if (!b.text) b.startedAt = t;
    b.text += delta;
    if (typeof endMs === "number") b.lastEndMs = Math.max(b.lastEndMs, endMs);
    if (b.timer) clearTimeout(b.timer);
    b.timer = setTimeout(() => { b.timer = null; this.flush(speaker); }, TURN_FLUSH_MS);
    b.timer.unref?.();
  }
  private flush(speaker: "human" | "assistant") {
    const b = this.buffers[speaker];
    if (b.timer) { clearTimeout(b.timer); b.timer = null; }
    const text = b.text.replace(/\s+/g, " ").trim();
    b.text = "";
    b.lastEndMs = -1;
    if (!text) return;
    this.pushTurn({ speaker, text, at: new Date(b.startedAt).toISOString() }, b.startedAt);
  }
  private flushAll() { this.flush("human"); this.flush("assistant"); }

  private pushTurn(turn: TranscriptTurn, startedAt?: number) {
    const t = { ...turn, at: turn.at ?? new Date(this.now()).toISOString() };
    // Keep chronological order by start time even when overlapping speech flushes out of order.
    let i = this.turns.length;
    if (startedAt !== undefined) while (i > 0 && this.turns[i - 1].at && Date.parse(this.turns[i - 1].at!) > startedAt) i--;
    this.turns.splice(i, 0, t);
    this.emit("turn", t);
  }

  private async dispatchTool(name: string, callId: string, rawArgs: unknown) {
    if (!name || !callId || this.handledCalls.has(callId)) return;
    this.handledCalls.add(callId);
    let args: Record<string, unknown> = {};
    try { args = typeof rawArgs === "string" ? JSON.parse(rawArgs || "{}") : (rawArgs as Record<string, unknown>) ?? {}; } catch { /* keep {} */ }
    // A delegated tool call means the preceding utterances are complete enough to close their turns.
    this.flushAll();
    log.info("openai_live.tool_call", { session_id: this.sessionId, tool: name, args });
    this.emit("tool", name, args);
    let output: unknown;
    try {
      switch (name) {
        case "report_outcome":
          this.outcome = args; this.emit("outcome", args); output = { recorded: true }; break;
        case "ask_owner": {
          this.pushTurn({ speaker: "system", text: `[asked owner: ${String(args.question)}]` });
          const answer = await this.opts.hooks.onAskOwner(String(args.question), args.options as string[] | undefined);
          this.pushTurn({ speaker: "system", text: answer ? `[owner answered: ${answer}]` : "[owner did not answer in time]" });
          output = { answer: answer ?? "NO_ANSWER" }; break;
        }
        case "end_call":
          output = { ok: true };
          this.sendToolOutput(callId, output);
          this.flushAll();
          await this.opts.hooks.onEndCall(String(args.reason));
          return;
        case "note_hold":
          this.pushTurn({ speaker: "system", text: `[hold: ${String(args.note)}]` });
          output = { ok: true }; break;
        default:
          output = { error: `unknown tool ${name}` };
      }
    } catch (e) {
      output = { error: String(e) };
    }
    // Interrupted speech does not cancel backend work, and a hold for the owner can outlive the call. A result that
    // arrives after the session started closing is stale: keep it in the transcript, do not feed it back.
    if (this.closed || this.closeRequested) { log.info("openai_live.stale_tool_result", { session_id: this.sessionId, tool: name }); this.emit("stale_result", name, args); return; }
    this.sendToolOutput(callId, output);
    this.send({ type: "response.create", event_id: `continue_${randomUUID()}` });
  }

  private sendToolOutput(callId: string, output: unknown) {
    this.send({ type: "response.item.create", event_id: `tool_result_${callId}`, item: { type: "function_call_output", call_id: callId, output: JSON.stringify(output) } });
  }
}
