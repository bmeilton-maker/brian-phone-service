import { assertProvider, config } from "./config.js";
import { log } from "./logger.js";
import { BlandProvider } from "./providers/bland.js";
import { MockProvider } from "./providers/mock.js";
import { OpenAiLiveProvider } from "./providers/openai_live/index.js";
import { XaiProvider } from "./providers/xai/index.js";
import { PhoneService } from "./service.js";
import { CallStore } from "./store.js";
import type { PhoneProvider, ProviderName } from "./types.js";

/** Wire real providers from env. Bland is always registered (fallback). xAI / openai_live only when configured; mock always. */
export function createService(): { service: PhoneService; xai: XaiProvider | null; openaiLive: OpenAiLiveProvider | null } {
  const defaultProvider = assertProvider(config.provider);
  const providers: Partial<Record<ProviderName, PhoneProvider>> = { bland: new BlandProvider(), mock: new MockProvider() };

  let xai: XaiProvider | null = null;
  const xaiMissing = XaiProvider.preflight();
  if (xaiMissing.length === 0) { xai = new XaiProvider(); providers.xai = xai; }
  else log.warn("xai.not_configured", { missing: xaiMissing, note: "xai provider disabled until these env vars are set" });
  if (defaultProvider === "xai" && !xai) throw new Error(`PHONE_PROVIDER=xai but xai is not configured (missing ${xaiMissing.join(", ")})`);

  let openaiLive: OpenAiLiveProvider | null = null;
  const liveMissing = OpenAiLiveProvider.preflight();
  if (liveMissing.length === 0) { openaiLive = new OpenAiLiveProvider(); providers.openai_live = openaiLive; }
  else log.warn("openai_live.not_configured", { missing: liveMissing, note: "openai_live provider disabled until these env vars are set" });
  if (defaultProvider === "openai_live" && !openaiLive) throw new Error(`PHONE_PROVIDER=openai_live but openai_live is not configured (missing ${liveMissing.join(", ")})`);

  if (defaultProvider === "bland" && !config.bland.apiKey) log.warn("bland.no_api_key", { note: "calls will fail until BLAND_API_KEY is set" });
  const service = new PhoneService({ providers, defaultProvider, store: new CallStore(config.dataDir), useLlmExtraction: !!config.xai.apiKey });
  log.info("service.ready", { default_provider: defaultProvider, providers: Object.keys(providers) });
  return { service, xai, openaiLive };
}
