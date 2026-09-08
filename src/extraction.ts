import { config } from "./config.js";
import { log } from "./logger.js";
import type { CallEnvelope, NormalizedResult, ProviderCallOutcome, ResultStatus } from "./types.js";

/**
 * Post-call extraction: turn a transcript + provider outcome into the normalized result.
 * Strategy:
 *  1. If the provider produced a structured extraction (xAI report_outcome tool call), trust it as the base.
 *  2. If an XAI_API_KEY is set, ask a text model to fill/verify the schema from the transcript.
 *  3. Otherwise, heuristic extraction (regex for confirmation numbers, dates) so demo/mock mode still returns structure.
 */

export const RESULT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "status", "summary", "human_or_business_reached", "results", "commitments_made", "financial_commitments",
    "dates_and_times", "confirmation_numbers", "follow_up_required", "follow_up", "questions_for_brian",
  ],
  properties: {
    status: { type: "string", enum: ["success", "partial", "failed", "needs_user"] },
    summary: { type: "string" },
    human_or_business_reached: { type: "string" },
    results: { type: "object", additionalProperties: true },
    commitments_made: { type: "array", items: { type: "string" } },
    financial_commitments: { type: "array", items: { type: "string" } },
    dates_and_times: { type: "array", items: { type: "string" } },
    confirmation_numbers: { type: "array", items: { type: "string" } },
    follow_up_required: { type: "boolean" },
    follow_up: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          required: ["action", "by_whom"],
          properties: {
            action: { type: "string" },
            by_whom: { type: "string", enum: ["brian", "business", "assistant"] },
            due: { type: ["string", "null"] },
            contact: { type: ["string", "null"] },
          },
        },
      ],
    },
    questions_for_brian: { type: "array", items: { type: "string" } },
  },
} as const;

type Extracted = Pick<
  NormalizedResult,
  | "status" | "summary" | "human_or_business_reached" | "results" | "commitments_made" | "financial_commitments"
  | "dates_and_times" | "confirmation_numbers" | "follow_up_required" | "follow_up" | "questions_for_brian"
>;

export function heuristicExtract(env: CallEnvelope, out: ProviderCallOutcome): Extracted {
  const t = out.transcript;
  const confirmations = [...t.matchAll(/\b(?:confirmation|reference|ticket|case)\s*(?:number|#|no\.?)?\s*(?:is|:)?\s*([A-Z0-9][A-Z0-9-]{3,})/gi)].map((m) => m[1]);
  const dates = [...t.matchAll(/\b((?:Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day(?:,?\s+\w+\s+\d{1,2})?(?:\s+at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm|AM|PM)?)?)/g)].map((m) => m[1]);
  const status: ResultStatus = out.error || (!out.human_answered && !out.voicemail && !t)
    ? "failed"
    : out.voicemail
      ? "partial"
      : confirmations.length || dates.length
        ? "success"
        : "partial";
  return {
    status,
    summary: out.voicemail
      ? "Reached voicemail; left a message requesting a callback."
      : out.error
        ? `Call failed: ${out.error}`
        : `Call completed (${out.duration_seconds ?? 0}s). Transcript captured; review results for details.`,
    human_or_business_reached: out.voicemail ? "voicemail" : out.human_answered ? "human" : "unknown",
    results: Object.fromEntries(env.required_outputs.map((k) => [k, null])),
    commitments_made: [],
    financial_commitments: [],
    dates_and_times: dates,
    confirmation_numbers: confirmations,
    follow_up_required: status !== "success",
    follow_up: status !== "success" ? { action: "Review transcript and decide next step", by_whom: "brian", due: null, contact: null } : null,
    questions_for_brian: [],
  };
}

async function llmExtract(env: CallEnvelope, out: ProviderCallOutcome): Promise<Extracted | null> {
  if (!config.xai.apiKey) return null;
  const owner = env.identity.owner_name;
  const body = {
    model: config.xai.extractionModel,
    temperature: 0,
    messages: [
      {
        role: "system",
        content: `You convert phone-call transcripts into a strict JSON result for ${owner}. Never invent details. If something was not said on the call, leave it null/empty. "status" = success only if the objective and required outputs were achieved without any unauthorized commitment; needs_user if the call ended because ${owner}'s decision is required; partial if some progress; failed otherwise. Summary is one concise paragraph for ${owner}.`,
      },
      {
        role: "user",
        content: JSON.stringify({
          objective: env.objective,
          required_outputs: env.required_outputs,
          authority: env.authority,
          answered: { human_answered: out.human_answered, voicemail: out.voicemail, error: out.error },
          transcript: out.transcript,
        }),
      },
    ],
    response_format: { type: "json_schema", json_schema: { name: "call_result", strict: true, schema: RESULT_JSON_SCHEMA } },
  };
  const res = await fetch(`${config.xai.apiBaseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${config.xai.apiKey}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    log.warn("extraction.llm_failed", { status: res.status, text: (await res.text()).slice(0, 500) });
    return null;
  }
  const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const content = json.choices?.[0]?.message?.content;
  if (!content) return null;
  try {
    return JSON.parse(content) as Extracted;
  } catch (e) {
    log.warn("extraction.bad_json", { error: String(e) });
    return null;
  }
}

export async function extractResult(
  task_id: string,
  env: CallEnvelope,
  out: ProviderCallOutcome,
  opts: { useLlm?: boolean } = {},
): Promise<NormalizedResult> {
  const base = heuristicExtract(env, out);
  const llm = opts.useLlm === false ? null : await llmExtract(env, out).catch((e) => {
    log.warn("extraction.llm_error", { error: String(e) });
    return null;
  });
  const merged: Extracted = { ...base, ...(llm ?? {}), ...(out.provider_extraction ?? {}) } as Extracted;
  // Provider-level hard facts win over any model opinion.
  if (out.voicemail && merged.status === "success") merged.status = "partial";
  if (out.error && merged.status === "success") merged.status = "partial";
  return {
    task_id,
    ...merged,
    duration_seconds: out.duration_seconds ?? 0,
    transcript: out.transcript,
    recording_reference: out.recording_reference,
    provider: (out.raw?.provider as NormalizedResult["provider"]) ?? "mock",
    raw_provider_result: out.raw,
  };
}
