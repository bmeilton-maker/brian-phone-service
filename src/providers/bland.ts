import { config } from "../config.js";
import { buildAgentInstructions, buildFirstSentence } from "../envelope.js";
import { log } from "../logger.js";
import type { CallState, PhoneProvider, ProviderCallOutcome, StartCallInput, StartCallResult, TranscriptTurn } from "../types.js";

/**
 * BlandProvider: preserves the existing adapter behavior.
 *   POST https://api.bland.ai/v1/calls   (phone_number, task, first_sentence, voice, model, wait_for_greeting,
 *                                          interruptibility, background_track, temperature, record, max_duration, voicemail.action)
 *   GET  https://api.bland.ai/v1/calls/:id  polled until `completed`
 *   POST https://api.bland.ai/v1/calls/:id/stop
 * Docs: https://docs.bland.ai/api-v1/post/calls, /api-v1/get/calls-id, /api-v1/post/calls-id-stop
 * Auth: `authorization: <BLAND_API_KEY>` header.
 */

export interface BlandCallDetails {
  call_id: string;
  status?: string;
  completed?: boolean;
  queue_status?: string;
  answered_by?: string | null; // "human" | "voicemail" | "unknown" | "no-answer" | null
  summary?: string | null;
  transcripts?: { id?: number; user: string; text: string; created_at?: string }[];
  concatenated_transcript?: string | null;
  recording_url?: string | null;
  price?: number | null;
  call_length?: number | null; // minutes
  error_message?: string | null;
  variables?: Record<string, unknown>;
  [k: string]: unknown;
}

export interface BlandHttp {
  request(method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; json: unknown }>;
}

export class BlandProvider implements PhoneProvider {
  readonly name = "bland" as const;
  constructor(private http: BlandHttp = defaultHttp()) {}

  buildPayload(input: StartCallInput) {
    const task = buildAgentInstructions(input.envelope, {
      recipient_name: input.recipient_name,
      opening_instruction: input.opening_instruction,
      realtime_hold_supported: false,
      hold_seconds: config.needsUserHoldSeconds,
    });
    return {
      phone_number: input.phone_number,
      task,
      first_sentence: buildFirstSentence(input.envelope, input.recipient_name, input.opening_instruction),
      voice: input.preferred_voice ?? config.bland.voice,
      model: config.bland.model,
      wait_for_greeting: true,
      interruptibility: 3,
      background_track: config.bland.backgroundTrack,
      temperature: config.bland.temperature,
      record: true,
      max_duration: Math.max(1, Math.ceil(input.max_duration_seconds / 60)), // Bland takes minutes
      voicemail: { action: "leave_message" },
      ...(config.bland.fromNumber ? { from: config.bland.fromNumber } : {}),
      metadata: { task_id: input.task_id, idempotency_key: input.idempotency_key },
    };
  }

  async startCall(input: StartCallInput): Promise<StartCallResult> {
    const payload = this.buildPayload(input);
    log.info("bland.request", { task_id: input.task_id, phone_number: input.phone_number, max_duration: payload.max_duration });
    const { status, json } = await this.http.request("POST", "/v1/calls", payload);
    const body = json as { status?: string; call_id?: string; message?: string };
    if (status >= 300 || body.status === "error" || !body.call_id) {
      throw new Error(`Bland POST /v1/calls failed (${status}): ${body.message ?? JSON.stringify(json).slice(0, 300)}`);
    }
    log.info("bland.initiated", { task_id: input.task_id, call_id: body.call_id });
    return { call_id: body.call_id, state: "queued", raw: body as Record<string, unknown> };
  }

  async getOutcome(call_id: string): Promise<ProviderCallOutcome> {
    const { status, json } = await this.http.request("GET", `/v1/calls/${call_id}`);
    if (status >= 300) throw new Error(`Bland GET /v1/calls/${call_id} failed (${status})`);
    return mapBlandDetails(json as BlandCallDetails);
  }

  async cancelCall(call_id: string) {
    const { status, json } = await this.http.request("POST", `/v1/calls/${call_id}/stop`);
    const body = json as { status?: string; message?: string };
    return { cancelled: status < 300 && body.status === "success", message: body.message };
  }
}

export function mapBlandDetails(d: BlandCallDetails): ProviderCallOutcome {
  const turns: TranscriptTurn[] = (d.transcripts ?? []).map((t) => ({
    speaker: t.user === "assistant" || t.user === "agent" ? "assistant" : t.user === "user" || t.user === "human" ? "human" : "system",
    text: t.text,
    at: t.created_at ?? null,
  }));
  const transcript = d.concatenated_transcript ?? turns.map((t) => `${t.speaker}: ${t.text}`).join("\n");
  const ended = d.completed === true || d.status === "completed" || d.status === "failed" || d.queue_status === "complete";
  const answered = (d.answered_by ?? "").toLowerCase();
  const voicemail = answered === "voicemail";
  const human = answered === "human";
  let state: CallState = ended ? (d.error_message ? "failed" : "completed") : d.queue_status === "started" ? "in_progress" : d.queue_status === "queued" || d.queue_status === "new" ? "queued" : "dialing";
  if (ended && !transcript && answered === "no-answer") state = "failed";
  return {
    call_id: d.call_id,
    ended,
    state,
    human_answered: ended ? human : null,
    voicemail: ended ? voicemail : null,
    duration_seconds: d.call_length != null ? Math.round(d.call_length * 60) : null,
    transcript,
    transcript_turns: turns,
    recording_reference: d.recording_url ?? null,
    error: d.error_message ?? (ended && answered === "no-answer" ? "no_answer" : null),
    cost_usd: d.price ?? null,
    provider_extraction: d.summary ? { summary: d.summary } : null,
    raw: { provider: "bland", ...d },
  };
}

function defaultHttp(): BlandHttp {
  return {
    async request(method, path, body) {
      if (!config.bland.apiKey) throw new Error("BLAND_API_KEY is not set");
      const res = await fetch(`${config.bland.baseUrl}${path}`, {
        method,
        headers: { authorization: config.bland.apiKey, "content-type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      let json: unknown = {};
      try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
      if (!res.ok) log.warn("bland.http_error", { method, path, status: res.status, body: text.slice(0, 300) });
      return { status: res.status, json };
    },
  };
}
