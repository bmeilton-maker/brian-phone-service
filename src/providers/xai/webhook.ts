import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * xAI signs `realtime.call.incoming` webhooks with headers webhook-id, webhook-timestamp,
 * webhook-signature and the signing secret returned when the SIP number was registered.
 * This implements the Standard Webhooks scheme (base64 HMAC-SHA256 over "id.timestamp.body",
 * header value "v1,<sig>", secret optionally prefixed "whsec_").
 * VERIFY against https://docs.x.ai/developers/model-capabilities/audio/voice-agent/sip before go-live.
 */
export function verifyXaiWebhook(
  headers: Record<string, string | string[] | undefined>,
  rawBody: string,
  secret: string,
  toleranceSeconds = 300,
  now = Date.now(),
): { ok: boolean; reason?: string } {
  if (!secret) return { ok: false, reason: "XAI_WEBHOOK_SECRET not set" };
  const h = (k: string) => {
    const v = headers[k] ?? headers[k.toLowerCase()];
    return Array.isArray(v) ? v[0] : v;
  };
  const id = h("webhook-id");
  const ts = h("webhook-timestamp");
  const sig = h("webhook-signature");
  if (!id || !ts || !sig) return { ok: false, reason: "missing webhook headers" };
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum) || Math.abs(now / 1000 - tsNum) > toleranceSeconds) return { ok: false, reason: "timestamp outside tolerance" };
  const key = secret.startsWith("whsec_") ? Buffer.from(secret.slice(6), "base64") : Buffer.from(secret, "utf8");
  const expected = createHmac("sha256", key).update(`${id}.${ts}.${rawBody}`).digest("base64");
  for (const part of sig.split(/\s+/)) {
    const [, value] = part.includes(",") ? part.split(",", 2) : ["v1", part];
    const a = Buffer.from(value ?? "");
    const b = Buffer.from(expected);
    if (a.length === b.length && timingSafeEqual(a, b)) return { ok: true };
  }
  return { ok: false, reason: "signature mismatch" };
}

/** Helper for tests and for the runbook's curl example. */
export function signXaiWebhook(id: string, ts: string, rawBody: string, secret: string): string {
  const key = secret.startsWith("whsec_") ? Buffer.from(secret.slice(6), "base64") : Buffer.from(secret, "utf8");
  return `v1,${createHmac("sha256", key).update(`${id}.${ts}.${rawBody}`).digest("base64")}`;
}
