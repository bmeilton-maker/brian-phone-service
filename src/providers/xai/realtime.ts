import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { config } from "../../config.js";
import { log } from "../../logger.js";
import { RESULT_JSON_SCHEMA } from "../../extraction.js";
import type { TranscriptTurn } from "../../types.js";

/**
 * One xAI realtime session attached to a SIP call.
 *   wss://api.x.ai/v1/realtime?call_id={call_id}   Authorization: Bearer XAI_API_KEY
 *   -> session.update { voice, instructions, turn_detection, tools }
 *   -> response.create (agent speaks first; deferred until the PSTN leg answers when deferGreeting is set)
 * Verified event names (docs + reference clients): session.created, session.updated, conversation.created,
 *   input_audio_buffer.speech_started/stopped, conversation.item.input_audio_transcription.completed,
 *   response.output_audio_transcript.delta/done, response.done, error.
 * Function calling follows the OpenAI-Realtime-compatible shape (response.output[] items of type
 *   "function_call"; reply with conversation.item.create {type:"function_call_output"} then response.create).
 *   VERIFY the exact field names against the xAI Voice Agent API docs; see docs/XAI_RUNBOOK.md.
 */

export const TOOL_NAMES = ["report_outcome", "ask_owner", "end_call", "send_dtmf", "note_hold"] as const;

export function sessionTools(ownerName: string) {
  return [
    { type: "function", name: "report_outcome", description: `Record the structured outcome of the call for ${ownerName}. Call this once, right before saying goodbye, or as soon as the call clearly cannot proceed.`, parameters: RESULT_JSON_SCHEMA },
    { type: "function", name: "ask_owner", description: `Ask ${ownerName} a question you cannot answer from your instructions or authority. Say "one moment" to the person first. Returns ${ownerName}'s answer, or "NO_ANSWER" if they did not respond in time.`,
      parameters: { type: "object", additionalProperties: false, required: ["question"], properties: { question: { type: "string" }, options: { type: "array", items: { type: "string" } } } } },
    { type: "function", name: "end_call", description: "Hang up. Only after you have said goodbye and called report_outcome.", parameters: { type: "object", additionalProperties: false, required: ["reason"], properties: { reason: { type: "string", enum: ["objective_complete", "voicemail_left", "wrong_number", "cannot_complete", "needs_owner", "hold_too_long", "other"] } } } },
    { type: "function", name: "send_dtmf", description: "Press digits on a phone menu.", parameters: { type: "object", additionalProperties: false, required: ["digits"], properties: { digits: { type: "string", pattern: "^[0-9*#]{1,10}$" } } } },
    { type: "function", name: "note_hold", description: "Record that you have been placed on hold or hear hold music/silence.", parameters: { type: "object", additionalProperties: false, required: ["note"], properties: { note: { type: "string" } } } },
  ];
}

export interface RealtimeHooks {
  onAskOwner(question: string, options?: string[]): Promise<string | null>; // resolves with answer or null after hold timeout
  onEndCall(reason: string): Promise<void>;
  onSendDtmf(digits: string): Promise<{ ok: boolean; message?: string }>;
}

export interface SessionEvents {
  turn: (t: TranscriptTurn) => void;
  outcome: (o: Record<string, unknown>) => void;
  closed: (info: { code: number; reason: string }) => void;
  error: (e: Error) => void;
  tool: (name: string, args: Record<string, unknown>) => void;
}

export interface WsLike {
  on(event: "open" | "message" | "close" | "error", cb: (...a: any[]) => void): unknown;
  send(data: string): void;
  close(): void;
}

export class XaiRealtimeSession extends EventEmitter {
  readonly turns: TranscriptTurn[] = [];
  outcome: Record<string, unknown> | null = null;
  private ws: WsLike | null = null;
  private assistantBuffer = "";
  private handledCalls = new Set<string>();

  constructor(
    private opts: { call_id: string; instructions: string; voice: string; ownerName: string; hooks: RealtimeHooks; wsFactory?: (url: string, headers: Record<string, string>) => WsLike; deferGreeting?: boolean; greetingWaitMs?: number; autoResponseGraceMs?: number },
  ) { super(); }

  private open = false;
  private greeted = false;
  private answered = false;
  private humanSpoke = false;
  private responding = false;
  private greetingTimer: NodeJS.Timeout | null = null;
  private graceTimer: NodeJS.Timeout | null = null;
  closed = false;

  /**
   * Greeting policy (Brian's locked preference): the agent never speaks on bare pickup.
   *   1. onHumanAnswered(): arm a wait of greetingWaitMs. Silence from the agent.
   *   2. Human speaks (speech_stopped or transcript): xAI's server VAD normally auto-responds. We give it
   *      autoResponseGraceMs; if no response has started by then, we nudge with response.create.
   *   3. Nobody speaks for greetingWaitMs (silent pickup, IVR already talking, etc.): open anyway.
   * ask_owner / tool outputs still use response.create directly (those are mid-conversation continuations).
   */
  onHumanAnswered(): void {
    if (this.answered) return;
    this.answered = true;
    if (!this.open) { this.opts.deferGreeting = false; return; } // connect() will call this again on open
    if (this.humanSpoke) { this.ensureResponse(); return; }
    this.greetingTimer = setTimeout(() => { this.greetingTimer = null; if (!this.greeted) { this.emit("greeting_fallback"); this.ensureResponse(); } }, this.opts.greetingWaitMs ?? 3000);
    this.greetingTimer.unref?.();
  }

  /** Back-compat alias: immediate greeting. Only used when the human is already talking or by explicit callers. */
  startConversation(): void { this.onHumanAnswered(); }

  private onHumanSpeech(): void {
    if (!this.answered) return; // pre-answer noise on the SIP leg (ringback/IVR) is not a greeting
    if (this.humanSpoke) return;
    this.humanSpoke = true;
    if (this.greetingTimer) { clearTimeout(this.greetingTimer); this.greetingTimer = null; }
    // Let server VAD auto-respond first; nudge only if it does not.
    this.graceTimer = setTimeout(() => { this.graceTimer = null; if (!this.responding && !this.greeted) this.ensureResponse(); }, this.opts.autoResponseGraceMs ?? 800);
    this.graceTimer.unref?.();
  }

  private ensureResponse(): void {
    if (this.greeted || !this.open) return;
    this.greeted = true;
    this.send({ type: "response.create", metadata: { client_event_id: randomUUID() } });
  }

  connect(): void {
    const url = `${config.xai.realtimeUrl}?call_id=${encodeURIComponent(this.opts.call_id)}`;
    const headers = { Authorization: `Bearer ${config.xai.apiKey}` };
    const factory = this.opts.wsFactory ?? ((u, h) => new WebSocket(u, { headers: h }) as unknown as WsLike);
    this.ws = factory(url, headers);
    this.ws.on("open", () => {
      log.info("xai.realtime.open", { call_id: this.opts.call_id });
      this.send({
        type: "session.update",
        session: {
          model: config.xai.realtimeModel,
          voice: this.opts.voice,
          instructions: this.opts.instructions,
          // VERIFY field names against xAI Voice Agent docs (OpenAI-Realtime-compatible naming assumed).
          turn_detection: {
            type: "server_vad",
            threshold: config.xai.vadThreshold,
            prefix_padding_ms: config.xai.vadPrefixPaddingMs,
            silence_duration_ms: config.xai.vadSilenceMs,
          },
          tools: sessionTools(this.opts.ownerName),
          tool_choice: "auto",
        },
      });
      this.open = true;
      // Never speak on open. If the provider already knows the human answered (deferGreeting false), arm the greeting wait now.
      if (!this.opts.deferGreeting) { this.answered = false; this.onHumanAnswered(); }
    });
    this.ws.on("message", (data: unknown) => this.handle(String(data)));
    this.ws.on("close", (code: number, reason: unknown) => { this.closed = true; this.emit("closed", { code, reason: String(reason ?? "") }); });
    this.ws.on("error", (e: Error) => { log.error("xai.realtime.error", { error: String(e) }); this.emit("error", e); });
  }

  close(): void {
    if (this.greetingTimer) clearTimeout(this.greetingTimer);
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.ws?.close();
  }

  private send(msg: Record<string, unknown>) {
    this.ws?.send(JSON.stringify(msg));
  }

  /** Public for tests: feed a raw server event. */
  async handle(raw: string): Promise<void> {
    let ev: any;
    try { ev = JSON.parse(raw); } catch { return; }
    switch (ev.type) {
      case "conversation.item.input_audio_transcription.completed": {
        const text = ev.transcript ?? ev.item?.content?.[0]?.transcript ?? "";
        if (text) this.pushTurn({ speaker: "human", text });
        this.onHumanSpeech();
        break;
      }
      case "input_audio_buffer.speech_stopped":
        this.onHumanSpeech();
        break;
      case "response.created":
        this.responding = true; this.greeted = true;
        if (this.graceTimer) { clearTimeout(this.graceTimer); this.graceTimer = null; }
        break;
      case "response.output_audio_transcript.delta":
        this.responding = true; this.greeted = true;
        this.assistantBuffer += ev.delta ?? "";
        break;
      case "response.output_audio_transcript.done": {
        const text = ev.transcript ?? this.assistantBuffer;
        this.assistantBuffer = "";
        if (text) this.pushTurn({ speaker: "assistant", text });
        break;
      }
      case "input_audio_buffer.speech_started":
        // Barge-in: xAI server VAD truncates output on its own; nothing to do server-side.
        break;
      case "response.function_call_arguments.done":
        await this.dispatchTool(ev.name, ev.call_id, ev.arguments);
        break;
      case "response.done": {
        this.responding = false;
        for (const item of ev.response?.output ?? []) {
          if (item.type === "function_call") await this.dispatchTool(item.name, item.call_id, item.arguments);
        }
        break;
      }
      case "error":
        log.error("xai.realtime.server_error", { error: ev.error ?? ev });
        this.emit("error", new Error(JSON.stringify(ev.error ?? ev)));
        break;
      default:
        break;
    }
  }

  private pushTurn(t: TranscriptTurn) {
    const turn = { ...t, at: new Date().toISOString() };
    this.turns.push(turn);
    this.emit("turn", turn);
  }

  private async dispatchTool(name: string, callId: string, rawArgs: unknown) {
    if (!name || this.handledCalls.has(callId)) return;
    this.handledCalls.add(callId);
    let args: Record<string, unknown> = {};
    try { args = typeof rawArgs === "string" ? JSON.parse(rawArgs || "{}") : (rawArgs as Record<string, unknown>) ?? {}; } catch { /* keep {} */ }
    log.info("xai.tool_call", { call_id: this.opts.call_id, tool: name, args });
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
          await this.opts.hooks.onEndCall(String(args.reason));
          return;
        case "send_dtmf":
          this.pushTurn({ speaker: "system", text: `[dtmf ${String(args.digits)}]` });
          output = await this.opts.hooks.onSendDtmf(String(args.digits)); break;
        case "note_hold":
          this.pushTurn({ speaker: "system", text: `[hold: ${String(args.note)}]` });
          output = { ok: true }; break;
        default:
          output = { error: `unknown tool ${name}` };
      }
    } catch (e) {
      output = { error: String(e) };
    }
    this.sendToolOutput(callId, output);
    this.send({ type: "response.create", metadata: { client_event_id: randomUUID() } });
  }

  private sendToolOutput(callId: string, output: unknown) {
    this.send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: callId, output: JSON.stringify(output) } });
  }
}
