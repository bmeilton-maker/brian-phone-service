import { assertProvider, config } from "./config.js";
import { log } from "./logger.js";
import { BlandProvider } from "./providers/bland.js";
import { MockProvider } from "./providers/mock.js";
import { XaiProvider } from "./providers/xai/index.js";
import { PhoneService } from "./service.js";
import { CallStore } from "./store.js";
import type { PhoneProvider, ProviderName } from "./types.js";

/** Wire real providers from env. Bland is always registered (fallback). xAI only when configured; mock always. */
export function createService(): { service: PhoneService; xai: XaiProvider | null } {
  const defaultProvider = assertProvider(config.provider);
  const providers: Partial<Record<ProviderName, PhoneProvider>> = { bland: new BlandProvider(), mock: new MockProvider() };
  let xai: XaiProvider | null = null;
  const missing = XaiProvider.preflight();
  if (missing.length === 0) { xai = new XaiProvider(); providers.xai = xai; }
  else log.warn("xai.not_configured", { missing, note: "xai provider disabled until these env vars are set" });
  if (defaultProvider === "xai" && !xai) throw new Error(`PHONE_PROVIDER=xai but xai is not configured (missing ${missing.join(", ")})`);
  if (defaultProvider === "bland" && !config.bland.apiKey) log.warn("bland.no_api_key", { note: "calls will fail until BLAND_API_KEY is set" });
  const service = new PhoneService({ providers, defaultProvider, store: new CallStore(config.dataDir), useLlmExtraction: !!config.xai.apiKey });
  log.info("service.ready", { default_provider: defaultProvider, providers: Object.keys(providers) });
  return { service, xai };
}
