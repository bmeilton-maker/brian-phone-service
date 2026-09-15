import type { ProviderName } from "./types.js";

function env(name: string, fallback = ""): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}
function num(name: string, fallback: number): number {
  const v = Number(env(name));
  return Number.isFinite(v) && env(name) !== "" ? v : fallback;
}

export const config = {
  provider: env("PHONE_PROVIDER", "bland") as ProviderName,
  port: num("PORT", 8787),
  publicBaseUrl: env("PUBLIC_BASE_URL").replace(/\/$/, ""),
  serviceToken: env("PHONE_SERVICE_TOKEN"),
  dataDir: env("DATA_DIR", "./data"),
  logLevel: env("LOG_LEVEL", "info"),
  defaultMaxDurationSeconds: num("DEFAULT_MAX_DURATION_SECONDS", 600),
  /** How long the agent holds the line for Brian's answer (ask_owner) before falling back to a callback. */
  needsUserHoldSeconds: num("NEEDS_USER_HOLD_SECONDS", 60),
  /** After the hold timed out, an answer that arrives within this window is still delivered to the agent mid-call. */
  needsUserLateAnswerSeconds: num("NEEDS_USER_LATE_ANSWER_SECONDS", 180),

  bland: {
    apiKey: env("BLAND_API_KEY"),
    baseUrl: env("BLAND_BASE_URL", "https://api.bland.ai"),
    voice: env("BLAND_VOICE", "maya"),
    model: env("BLAND_MODEL", "base"),
    backgroundTrack: env("BLAND_BACKGROUND_TRACK", "office"),
    temperature: num("BLAND_TEMPERATURE", 0.5),
    fromNumber: env("BLAND_FROM_NUMBER"),
    pollIntervalMs: num("BLAND_POLL_INTERVAL_MS", 5000),
  },

  xai: {
    apiKey: env("XAI_API_KEY"),
    voice: env("XAI_VOICE", "eve"),
    realtimeModel: env("XAI_REALTIME_MODEL", "grok-voice-latest"),
    realtimeUrl: env("XAI_REALTIME_URL", "wss://api.x.ai/v1/realtime"),
    apiBaseUrl: env("XAI_API_BASE_URL", "https://api.x.ai"),
    extractionModel: env("XAI_EXTRACTION_MODEL", "grok-4-fast"),
    sipNumber: env("XAI_SIP_NUMBER"),
    sipDomain: env("XAI_SIP_DOMAIN", "sip.voice.x.ai"),
    webhookSecret: env("XAI_WEBHOOK_SECRET"),
    /** Server VAD tuning. silence_duration_ms is the pause before the agent takes its turn (~0.5s feel). */
    vadSilenceMs: num("XAI_VAD_SILENCE_MS", 400),
    vadThreshold: num("XAI_VAD_THRESHOLD", 0.5),
    vadPrefixPaddingMs: num("XAI_VAD_PREFIX_PADDING_MS", 300),
    /** After the human answers, wait this long for them to say hello before the agent opens anyway. */
    greetingWaitMs: num("XAI_GREETING_WAIT_MS", 3000),
    /** After the human's greeting, wait this long for xAI's auto-response before nudging with response.create. */
    autoResponseGraceMs: num("XAI_AUTO_RESPONSE_GRACE_MS", 800),
  },

  openaiLive: {
    apiKey: env("OPENAI_API_KEY"),
    model: env("OPENAI_LIVE_MODEL", "gpt-live-1"),
    /** GPT-Live voice. Brian's pick is willow; others: marin (OpenAI default), gleam, meridian, quartz, ripple, vesper, stone, delta, cinder ... */
    voice: env("OPENAI_LIVE_VOICE", "willow"),
    /** Responses-delegation backend that runs report_outcome / ask_owner / end_call. Docs: start with gpt-5.6-terra; gpt-5.6-luna is cheaper. */
    backendModel: env("OPENAI_LIVE_BACKEND_MODEL", "gpt-5.6-terra"),
    /** Optional `reasoning.effort` for the backend model (e.g. low). Unset = model default. */
    backendReasoningEffort: env("OPENAI_LIVE_BACKEND_REASONING_EFFORT"),
    /** Optional `service_tier` for the backend (auto | default | flex | priority). Unset = project default. */
    backendServiceTier: env("OPENAI_LIVE_BACKEND_SERVICE_TIER"),
    wsUrl: env("OPENAI_LIVE_WS_URL", "wss://api.openai.com/v1/live/sessions"),
    /** After the callee picks up, stay silent this long waiting for their hello before the agent opens anyway. */
    greetingWaitMs: num("OPENAI_LIVE_GREETING_WAIT_MS", 3000),
    /**
     * Hangup sequence: after end_call / a goodbye, wait at most this long for the agent's goodbye audio to START (it
     * must cover one backend round trip when end_call arrives before the goodbye is spoken); once speaking, the goodbye
     * is allowed to finish and the line drops ~0.5 s + Twilio playout after its last word. 0 = hang up immediately (tests).
     */
    hangupDelayMs: num("OPENAI_LIVE_HANGUP_DELAY_MS", 3000),
    /** Hang up on farewell intent (agent goodbye sentence, or callee goodbye + agent silence), not only on end_call. */
    farewellHangup: env("OPENAI_LIVE_FAREWELL_HANGUP", "true").toLowerCase() !== "false",
    /** After the callee says goodbye, hang up once the agent has been silent this long (doubled while a backend delegation is in flight; the agent's own goodbye ends the call sooner). */
    farewellSilenceMs: num("OPENAI_LIVE_FAREWELL_SILENCE_MS", 2500),
    /**
     * Send Twilio `clear` (drop the agent audio still queued at Twilio) when the callee interrupts with something
     * substantive (not "mm-hm"/"okay"). GPT-Live stops generating on its own; this stops the already-buffered tail.
     */
    clearOnBargeIn: env("OPENAI_LIVE_CLEAR_ON_BARGE_IN", "true").toLowerCase() !== "false",
    /** session.store=true keeps a 30-day recording at OpenAI (must be enabled on the project). */
    store: env("OPENAI_LIVE_STORE", "false").toLowerCase() === "true",
    /** Twilio ring timeout (s) before no-answer. */
    ringTimeoutSeconds: num("OPENAI_LIVE_RING_TIMEOUT_SECONDS", 40),
  },

  twilio: {
    accountSid: env("TWILIO_ACCOUNT_SID"),
    authToken: env("TWILIO_AUTH_TOKEN"),
    fromNumber: env("TWILIO_FROM_NUMBER"),
    /** Set TWILIO_VALIDATE_SIGNATURE=false only for local debugging behind a tunnel that rewrites URLs. */
    validateSignature: env("TWILIO_VALIDATE_SIGNATURE", "true").toLowerCase() !== "false",
    /** Reconcile against Twilio if no status callback has arrived for this long (ms). */
    reconcileAfterMs: num("TWILIO_RECONCILE_AFTER_MS", 45_000),
  },
};

export function assertProvider(p: string): ProviderName {
  if (p === "bland" || p === "xai" || p === "openai_live" || p === "mock") return p;
  throw new Error(`Unknown PHONE_PROVIDER "${p}" (expected bland | xai | openai_live | mock)`);
}
