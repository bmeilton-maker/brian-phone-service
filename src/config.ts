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
  needsUserHoldSeconds: num("NEEDS_USER_HOLD_SECONDS", 45),

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
  if (p === "bland" || p === "xai" || p === "mock") return p;
  throw new Error(`Unknown PHONE_PROVIDER "${p}" (expected bland | xai | mock)`);
}
