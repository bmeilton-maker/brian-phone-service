# What Brian must provision

Do these in order. Bland-only operation needs only step 1.

## 1. Bland (already have)
- [ ] `BLAND_API_KEY` in `.env`
- [ ] Optional `BLAND_FROM_NUMBER` if you own a Bland number

## 2. xAI
- [ ] xAI API key with Voice Agent API access -> `XAI_API_KEY` (console: https://console.x.ai)
- [ ] Confirm billing enabled for realtime voice (docs list $0.05/min for the Voice Agent API; verify current pricing in the console)

## 3. Twilio (PSTN dialer for xAI)
- [ ] Twilio account, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`
- [ ] A voice-capable Twilio number -> `TWILIO_FROM_NUMBER` (this is the caller ID people see)
- [ ] Verify the number is allowed to place outbound calls in the US (Geo permissions)
- [ ] SIP: Twilio's `<Dial><Sip>` to an external SIP URI needs no trunk, but `sip.voice.x.ai;transport=tls` must be reachable. If xAI requires the calling number to be registered ("byo_trunk"), also create an Elastic SIP Trunk with origination URI `sip:{number}@sip.voice.x.ai;transport=tls` and attach `TWILIO_FROM_NUMBER` to it.

## 4. xAI Direct SIP number
- [ ] Register your number with xAI: `POST https://api.x.ai/v2/phone-numbers` with `origin: "byo_trunk"`, your E.164 number, and the webhook URL `PUBLIC_BASE_URL/webhooks/xai`. Save the returned signing secret -> `XAI_WEBHOOK_SECRET`; put the number in `XAI_SIP_NUMBER`.
  Exact request body: check https://docs.x.ai/developers/model-capabilities/audio/voice-agent/sip (this environment could not fetch it).

## 5. Public URL for webhooks
- [ ] A stable HTTPS URL to this service: Cloudflare Tunnel, ngrok (paid static domain), or a small VPS. -> `PUBLIC_BASE_URL`
- [ ] Open port `PORT` (8787) behind it. Set `PHONE_SERVICE_TOKEN`.

## 6. First live xAI test
- [ ] `npm run start:http`, hit `GET /healthz`, confirm `providers` includes `xai`
- [ ] `POST /calls` with `examples/make_call_xai_override.json` pointed at your own cell
- [ ] Watch logs for: `twilio.dialed` -> `twilio.status ringing` -> `xai.webhook` -> `xai.session_attached` -> `xai.realtime.open` -> `xai.tool_call report_outcome` -> `call.finalized`
- [ ] Open `data/calls/<task_id>.json` and confirm transcript + result

## Ring / Grok side
- [ ] Add the MCP server (`npm run start:mcp` in `phone-service/`) as `phone`
- [ ] Give the chief-of-staff prompt the envelope rules from README "Call envelope" and the poll loop from "How Grok / Ring calls it"
