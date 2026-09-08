import { createHash, randomUUID } from "node:crypto";
import { config } from "./config.js";
import { buildEnvelope } from "./envelope.js";
import { extractResult } from "./extraction.js";
import { log } from "./logger.js";
import { CallStore } from "./store.js";
import type { CallRecord, CallStatus, MakeCallRequest, NormalizedResult, PhoneProvider, ProviderCallOutcome, ProviderName } from "./types.js";

export interface PhoneServiceOptions {
  providers: Partial<Record<ProviderName, PhoneProvider>>;
  defaultProvider: ProviderName;
  store: CallStore;
  ownerName?: string;
  /** Poll interval for providers that need polling (Bland). */
  pollIntervalMs?: number;
  useLlmExtraction?: boolean;
}

const E164 = /^\+[1-9]\d{6,14}$/;

/**
 * PhoneService: the provider-independent surface Grok talks to.
 * make_call -> get_status -> get_result, plus cancel_call and answer_question (needs_user).
 */
export class PhoneService {
  private pollers = new Map<string, NodeJS.Timeout>();
  constructor(private o: PhoneServiceOptions) {}

  get providerNames(): ProviderName[] { return Object.keys(this.o.providers) as ProviderName[]; }

  private provider(name?: ProviderName): PhoneProvider {
    const n = name ?? this.o.defaultProvider;
    const p = this.o.providers[n];
    if (!p) throw new Error(`provider "${n}" is not configured (available: ${this.providerNames.join(", ")})`);
    return p;
  }

  async makeCall(req: MakeCallRequest): Promise<{ task_id: string; call_id: string | null; status: CallStatus["state"]; provider: ProviderName; deduplicated: boolean }> {
    if (!E164.test(req.phone_number)) throw new Error(`phone_number must be E.164 (got "${req.phone_number}")`);
    if (!req.objective?.trim()) throw new Error("objective is required");
    if (!Array.isArray(req.required_outputs)) throw new Error("required_outputs must be an array");
    const provider = this.provider(req.provider);
    const idem = req.idempotency_key ?? createHash("sha256").update(JSON.stringify({ n: req.phone_number, o: req.objective, r: req.required_outputs, c: req.relevant_context ?? {} })).digest("hex").slice(0, 32);
    const existing = this.o.store.findByIdempotency(provider.name, idem);
    if (existing) {
      log.info("call.deduplicated", { task_id: existing.task_id, idempotency_key: idem });
      return { task_id: existing.task_id, call_id: existing.call_id, status: existing.status.state, provider: existing.provider, deduplicated: true };
    }
    const task_id = `task_${randomUUID()}`;
    const envelope = buildEnvelope(req, this.o.ownerName ?? "Brian");
    const now = new Date().toISOString();
    const rec: CallRecord = {
      task_id, call_id: null, provider: provider.name, idempotency_key: idem, request: req, envelope,
      status: { task_id, call_id: null, provider: provider.name, state: "queued", started_at: null, ended_at: null, duration_seconds: null, human_answered: null, voicemail: null, intervention_required: false, pending_question: null, error: null },
      result: null, events: [], created_at: now, updated_at: now,
    };
    this.o.store.save(rec);
    this.o.store.appendEvent(task_id, "request.received", { provider: provider.name, recipient: req.recipient_name, phone_number: req.phone_number, required_outputs: req.required_outputs, authority: envelope.authority });
    try {
      const started = await provider.startCall({
        task_id, envelope, recipient_name: req.recipient_name, phone_number: req.phone_number, opening_instruction: req.opening_instruction,
        preferred_voice: req.preferred_voice, max_duration_seconds: req.max_duration_seconds ?? config.defaultMaxDurationSeconds, idempotency_key: idem,
      });
      rec.call_id = started.call_id;
      rec.status.call_id = started.call_id;
      rec.status.state = started.state;
      rec.status.started_at = new Date().toISOString();
      this.o.store.appendEvent(task_id, "call.initiated", { call_id: started.call_id, raw: started.raw });
      this.startPolling(task_id);
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      rec.status.state = "failed";
      rec.status.error = msg;
      rec.status.ended_at = new Date().toISOString();
      rec.result = failedResult(task_id, provider.name, msg);
      this.o.store.appendEvent(task_id, "call.initiation_failed", { error: msg });
      log.error("call.initiation_failed", { task_id, error: msg });
    }
    this.o.store.save(rec);
    return { task_id, call_id: rec.call_id, status: rec.status.state, provider: provider.name, deduplicated: false };
  }

  private startPolling(task_id: string) {
    const interval = this.o.pollIntervalMs ?? config.bland.pollIntervalMs;
    const tick = async () => {
      try { const done = await this.refresh(task_id); if (done) this.stopPolling(task_id); }
      catch (e) { log.warn("poll.error", { task_id, error: String(e) }); }
    };
    this.pollers.set(task_id, setInterval(tick, interval));
    this.pollers.get(task_id)?.unref?.();
  }
  private stopPolling(task_id: string) { const t = this.pollers.get(task_id); if (t) clearInterval(t); this.pollers.delete(task_id); }

  /** Pull the latest outcome from the provider and finalize if ended. Returns true when finished. */
  async refresh(task_id: string): Promise<boolean> {
    const rec = this.o.store.get(task_id);
    if (!rec) throw new Error(`unknown task ${task_id}`);
    if (rec.result) return true;
    if (!rec.call_id) return rec.status.state === "failed";
    const out = await this.provider(rec.provider).getOutcome(rec.call_id);
    applyOutcomeToStatus(rec.status, out);
    if (!out.ended) { this.o.store.save(rec); return false; }
    this.o.store.appendEvent(task_id, out.error ? "call.failed" : out.voicemail ? "call.voicemail" : "call.completed", { error: out.error, voicemail: out.voicemail, human_answered: out.human_answered, duration_seconds: out.duration_seconds, cost_usd: out.cost_usd });
    const t0 = Date.now();
    const result = await extractResult(task_id, rec.envelope, out, { useLlm: this.o.useLlmExtraction });
    result.provider = rec.provider;
    rec.result = result;
    rec.status.state = out.state === "cancelled" ? "cancelled" : out.state === "failed" ? "failed" : "completed";
    rec.status.ended_at = rec.status.ended_at ?? new Date().toISOString();
    rec.status.intervention_required = result.status === "needs_user";
    rec.status.pending_question = null;
    this.o.store.appendEvent(task_id, "result.extracted", { status: result.status, extraction_ms: Date.now() - t0, questions_for_brian: result.questions_for_brian, confirmation_numbers: result.confirmation_numbers });
    this.o.store.save(rec);
    log.info("call.finalized", { task_id, status: result.status, duration_seconds: result.duration_seconds, provider: rec.provider });
    return true;
  }

  async getStatus(id: { task_id?: string; call_id?: string }): Promise<CallStatus> {
    const rec = this.lookup(id);
    if (!rec.result) await this.refresh(rec.task_id).catch((e) => log.warn("status.refresh_failed", { task_id: rec.task_id, error: String(e) }));
    return this.o.store.get(rec.task_id)!.status;
  }

  async getResult(id: { task_id?: string; call_id?: string }): Promise<NormalizedResult | { pending: true; status: CallStatus }> {
    const rec = this.lookup(id);
    if (!rec.result) await this.refresh(rec.task_id).catch((e) => log.warn("result.refresh_failed", { task_id: rec.task_id, error: String(e) }));
    const fresh = this.o.store.get(rec.task_id)!;
    return fresh.result ?? { pending: true, status: fresh.status };
  }

  async cancelCall(id: { task_id?: string; call_id?: string }) {
    const rec = this.lookup(id);
    if (rec.result || !rec.call_id) return { cancelled: false, message: "call is not active" };
    const r = await this.provider(rec.provider).cancelCall(rec.call_id);
    this.o.store.appendEvent(rec.task_id, "call.cancel_requested", { ...r });
    if (r.cancelled) await this.refresh(rec.task_id).catch(() => undefined);
    return r;
  }

  /** needs_user flow: deliver Brian's answer while the agent holds the line. */
  async answerQuestion(id: { task_id?: string; call_id?: string }, question_id: string, answer: string) {
    const rec = this.lookup(id);
    const p = this.provider(rec.provider);
    if (!p.answerQuestion || !rec.call_id) return { delivered: false, message: `provider ${rec.provider} does not support live answers` };
    const r = await p.answerQuestion(rec.call_id, question_id, answer);
    this.o.store.appendEvent(rec.task_id, "owner.answer", { question_id, delivered: r.delivered, answer });
    return r;
  }

  listCalls() { return this.o.store.list().map((r) => ({ task_id: r.task_id, provider: r.provider, state: r.status.state, recipient: r.request.recipient_name, created_at: r.created_at, result_status: r.result?.status ?? null })); }

  private lookup(id: { task_id?: string; call_id?: string }): CallRecord {
    const rec = id.task_id ? this.o.store.get(id.task_id) : id.call_id ? this.o.store.findByCallId(id.call_id) : undefined;
    if (!rec) throw new Error(`unknown task/call: ${JSON.stringify(id)}`);
    return rec;
  }

  shutdown() { for (const k of this.pollers.keys()) this.stopPolling(k); }
}

function applyOutcomeToStatus(s: CallStatus, out: ProviderCallOutcome) {
  s.state = out.state;
  s.human_answered = out.human_answered;
  s.voicemail = out.voicemail;
  s.duration_seconds = out.duration_seconds;
  s.error = out.error;
  const pq = (out.raw?.pending_question ?? null) as CallStatus["pending_question"] | { question: string; options?: string[] } | null;
  s.pending_question = out.state === "needs_user" && pq ? { id: (pq as { id?: string }).id ?? "pending", question: pq.question, options: pq.options, asked_at: (pq as { asked_at?: string }).asked_at ?? new Date().toISOString() } : null;
  s.intervention_required = out.state === "needs_user";
}

export function failedResult(task_id: string, provider: ProviderName, error: string): NormalizedResult {
  return { task_id, status: "failed", summary: `Call could not be placed: ${error}`, human_or_business_reached: "none", results: {}, commitments_made: [], financial_commitments: [], dates_and_times: [], confirmation_numbers: [], follow_up_required: true, follow_up: { action: "Retry or call manually", by_whom: "brian", due: null, contact: null }, questions_for_brian: [], duration_seconds: 0, transcript: "", recording_reference: null, provider, raw_provider_result: { error } };
}
