# OpenAI GPT-Live-1 provider runbook (`openai_live`)

Purpose: A/B GPT-Live-1 against xAI on response latency with the same envelope, same Twilio number, same MCP tools.
Nothing about Bland or xAI changes; `openai_live` is a third provider behind `PhoneService`.

## Chosen path: Twilio Media Streams -> OpenAI Live Sessions WebSocket

```
Ring -> phone_make_call{provider:"openai_live"} -> Twilio REST dial (callee)
   callee answers -> TwiML <Connect><Stream url="wss://PUBLIC/webhooks/openai-live/media"><Parameter task_id/></Stream></Connect>
   Twilio WS (mu-law 8k) <-> this service <-> wss://api.openai.com/v1/live/sessions (gpt-live-1, audio/pcmu 8000)
   tools via Responses delegation (report_outcome / ask_owner / end_call / note_hold) -> Twilio hangup -> result
```

Why this and not OpenAI SIP (`sip:$PROJECT_ID@sip.api.openai.com`):

| | Media Streams (chosen) | OpenAI Direct SIP |
|---|---|---|
| Outbound | Documented by Twilio for GPT-Live-1 outbound (Sept 10 2026 tutorial). | OpenAI: "Creating an outbound SIP call through `POST /v1/live/sessions` is not supported." Would need Twilio to dial OpenAI's SIP first, then `<Dial>` the human (the xAI topology), plus a project webhook (`live.transport.incoming`), accept, and a sideband attach. |
| Correlation | Deterministic: the `start` frame carries our Twilio `CallSid` and a `task_id` custom parameter. | Via SIP headers on the webhook (untrusted per OpenAI docs) or oldest-pending guess. |
| Extra config | None beyond `OPENAI_API_KEY`. | Project SIP enablement, webhook secret, `PROJECT_ID`. |
| Audio | We relay G.711 mu-law bytes unchanged (OpenAI supports `audio/pcmu` 8 kHz on WebSocket). One extra hop through our process (a few ms on a decent tunnel). | Carrier-grade media path, SRTP. |
| Billing quirk | GPT-Live session starts only when the callee answers: no paying for ring time (xAI SIP-first bills from SIP answer). | Same as xAI: the OpenAI leg would be live during ring. |

Verdict for a latency trial: Media Streams. If the tunnel adds audible delay, the SIP path is the fallback (see "If Media Streams proves too laggy").

## What is verified (developers.openai.com + Twilio, Sept 2026)

| Item | Status |
|---|---|
| `wss://api.openai.com/v1/live/sessions`, `Authorization: Bearer`, `User-Agent` header requested | verified (WebSockets guide, Twilio tutorial) |
| `session.start { session:{ model:"gpt-live-1", instructions, audio:{format:{type:"audio/pcmu",rate:8000}, output:{voice}}, delegation } }` -> `session.started { session.id }` | verified |
| Audio: `session.input_audio.append {audio}` in, `session.output_audio.delta {delta}` out; no output-audio-done event; no `response.create` to speak | verified |
| Transcripts: `session.input_transcript.delta` / `session.output_transcript.delta` with `start_ms`/`end_ms`; fragments, not turns | verified |
| Responses delegation: `session.delegation.created`, `response.event{event:{type:"response.output_item.done", item:{type:"function_call", call_id, name, arguments}}}`, reply `response.item.create{function_call_output}` then `response.create` | verified (Delegation and tools) |
| Greeting before the caller speaks: `session.instructions.append` + `session.commentary.append` with `delegation_id:null` | verified (Managing sessions, Twilio tutorial) |
| Default behavior: GPT-Live waits for the user unless told to greet | verified (docs only describe explicit greeting) |
| Close: `session.close` -> `session.closed { reason, usage.seconds }`; `session.usage.updated` snapshots | verified |
| Pricing: $0.05/min voice layer, billed per second; backend tokens separate | verified (launch post) |
| Voices: `marin` default; `gleam`, `meridian`, `quartz`, `ripple`, `vesper`, `willow`, `stone`, `delta`, `cinder`, ... | verified |
| Twilio: `POST /Calls.json` with inline `Twiml=<Connect><Stream>`, `<Parameter>` custom params, `MachineDetection=Enable AsyncAmd=true AsyncAmdStatusCallback`, `Timeout`, `TimeLimit` | verified (Twilio docs / tutorial) |
| Twilio Media Streams frames: `connected`, `start{streamSid,callSid,customParameters}`, `media{payload,track}`, `stop`, `dtmf`; we send `media{streamSid,payload}` and `clear{streamSid}` | verified |

## Env

```
PHONE_PROVIDER=xai                # leave as is; flip per call first (see below)
OPENAI_API_KEY=sk-...             # project key with gpt-live-1 + backend model access
OPENAI_LIVE_MODEL=gpt-live-1
OPENAI_LIVE_VOICE=marin
OPENAI_LIVE_BACKEND_MODEL=gpt-5.6-terra      # docs: start here; gpt-5.6-luna is cheaper
OPENAI_LIVE_BACKEND_REASONING_EFFORT=        # optional, e.g. low
OPENAI_LIVE_BACKEND_SERVICE_TIER=            # optional, priority = Fast mode if enabled on the project
OPENAI_LIVE_GREETING_WAIT_MS=3000
OPENAI_LIVE_HANGUP_DELAY_MS=2500
OPENAI_LIVE_CLEAR_ON_BARGE_IN=false
OPENAI_LIVE_STORE=false
# reused: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER, PUBLIC_BASE_URL, NEEDS_USER_HOLD_SECONDS
```

Preflight (`OpenAiLiveProvider.preflight`) needs `OPENAI_API_KEY`, the three Twilio vars and `PUBLIC_BASE_URL`. Otherwise the service logs `openai_live.not_configured` and runs without it. No xAI vars are required for `openai_live`; if `XAI_API_KEY` is absent, post-call extraction falls back to `report_outcome` + heuristics (the xAI text model is only used when its key exists).

Twilio needs nothing new: same account, same `TWILIO_FROM_NUMBER`, no trunk, no SIP. The `PUBLIC_BASE_URL` tunnel must pass WebSocket upgrades (ngrok and Cloudflare Tunnel do).

## Place a self-call

```bash
npm run start:http                     # or start:mcp; both start the webhook listener when openai_live is configured
curl -s localhost:8787/healthz         # providers must include "openai_live"
curl -s -X POST localhost:8787/calls -H 'content-type: application/json' \
  -H "authorization: Bearer $PHONE_SERVICE_TOKEN" \
  -d @examples/make_call_openai_live_override.json     # edit phone_number to your cell first
```

Or from Ring: `phone_make_call` with `"provider": "openai_live"`. Then poll `phone_get_status` / `GET /calls/<task_id>/status`.

Expected log sequence (stderr JSON):
`twilio.dialed(path=media_streams)` -> `twilio.status ringing` -> `twilio.status in-progress` -> `openai_live.media.connected` -> `openai_live.session_attached` -> `openai_live.ws.open` -> `openai_live.session.started` -> (you say hello) -> transcript turns -> `openai_live.delegation` -> `openai_live.tool_call report_outcome` -> `openai_live.tool_call end_call` -> `openai_live.call_ended` -> `openai_live.session.closed` -> `call.finalized`.

Behavior to expect on the phone:
1. Your phone rings from `TWILIO_FROM_NUMBER`. Pick up. Silence.
2. Say "Hello?". The agent opens in one sentence ("Hi, this is Brian's AI assistant...") and pauses. If you say nothing for `OPENAI_LIVE_GREETING_WAIT_MS`, it opens anyway (`raw.greeting_fallback=true`).
3. Interrupt it mid-sentence: it should stop. If a tail of speech keeps playing, set `OPENAI_LIVE_CLEAR_ON_BARGE_IN=true` (drops Twilio's queued audio when your speech is transcribed).
4. Finish the task; it says goodbye, hangs up within ~`OPENAI_LIVE_HANGUP_DELAY_MS`.

## Flip the default for the trial

Per call: `"provider": "openai_live"` in `phone_make_call` (nothing else changes).
Process-wide: `PHONE_PROVIDER=openai_live` in `.env`, restart. xAI stays reachable via `"provider": "xai"`. Roll back by setting it back. Do not commit the flip.

## Reading latency from the result

`raw_provider_result.latency` (from `data/calls/<task_id>.json`):

| Field | Meaning |
|---|---|
| `session_started_ms` | OpenAI WS connect -> `session.started` (setup cost after pickup; xAI pays this during ring instead) |
| `first_human_transcript_ms` | `session.started` -> first human transcript fragment |
| `first_agent_audio_ms` | `session.started` -> first agent audio byte |
| `turn_latencies_ms[]` | human transcript stops -> agent audio starts, per agent turn (approximate: transcript arrival lags audio by a few hundred ms, so real gaps are slightly larger than shown) |
| `delegation_roundtrips_ms[]` | `session.delegation.created` -> nested `response.completed` (backend model + our tool) |
| `greeting_fallback` | callee said nothing; we prompted the opening |

Compare `turn_latencies_ms` with xAI's `response.created` gaps (3 to 11 s was the pain). GPT-Live's benchmark is ~0.8 s. Also `live_usage_seconds` and `cost_usd` (voice layer only).

Add a row to docs/SIDE_BY_SIDE_CHECKLIST.md for `openai_live` next to xAI.

## What must be confirmed on the first live call (marked in code)

1. **Delegation triggers.** The live prompt tells GPT-Live to delegate when the objective is done, when Brian's decision is needed, when it should hang up, or when on hold. If a completed call has no `openai_live.tool_call report_outcome`, the live model did not delegate: tighten `liveConversationAddendum` in `src/providers/openai_live/live.ts` (keep the `Delegation policy:` label format from OpenAI's prompting guide) or shorten the envelope prompt, which is long for the live model's taste.
2. **Goodbye vs hangup race.** `end_call` waits up to `OPENAI_LIVE_HANGUP_DELAY_MS` for agent audio to stop (600 ms quiet) before Twilio hangs up. If the goodbye is clipped, raise it; if the line hangs dead, lower it.
3. **Function-call item shape.** We read `response.event.event.item` with `type:"function_call"`, `status:"completed"`, `call_id`, `name`, `arguments` (docs). If `openai_live.tool_call` never logs but `openai_live.delegation` does, set `LOG_LEVEL=debug` and inspect the nested event types.
4. **Turn grouping.** Transcript turns are grouped on `start_ms`/`end_ms` (300 ms overlap tolerance, 1.5 s same-speaker gap). If turns look chopped or merged in `transcript`, tune `TURN_*` constants in `live.ts`.
5. **Voicemail.** Async AMD posts `AnsweredBy=machine_*` a few seconds after pickup; we then `session.instructions.append` a leave-a-message instruction. GPT-Live may already have started listening to the greeting; check the message actually lands after the beep.
6. **DTMF.** Not available on a Media Streams bridge (`send_dtmf` is omitted from the tool list; the prompt says to ask for a representative). Inbound key presses are logged as system turns.
7. **Recording.** Twilio recording is not enabled. `OPENAI_LIVE_STORE=true` keeps a 30-day stereo WAV at OpenAI (`GET /v1/live/sessions/{id}/content`, `recording_reference` is set) if the project allows storage; check consent rules first.
8. **Tunnel WebSocket**. If the call connects but stays silent, the tunnel is not passing the WS upgrade or `PUBLIC_BASE_URL` is wrong. Look for `openai_live.media.connected`; Twilio Console -> call -> Media Streams shows the URL it tried.

## If Media Streams proves too laggy

Switch to OpenAI Direct SIP with the xAI topology: Twilio dials `sip:$PROJECT_ID@sip.api.openai.com;transport=tls` first, our `live.transport.incoming` webhook accepts with `POST /v1/live/sessions/{session_id}/accept` (same session config minus `audio.format`), we attach a sideband at `wss://api.openai.com/v1/live/sessions/{session_id}/attach`, then TwiML `<Dial>`s the human. `OpenAiLiveSession` is reusable as is (skip `session.start`, keep everything else). Hangup via `POST /v1/live/sessions/{id}/hangup`. Requires enabling SIP on the project and a webhook secret. Not built.

## Dry run without keys

```
npm run demo -- openai-live-session
```
Drives `OpenAiLiveSession` with a fake socket: envelope -> `session.start` -> transcript fragments -> delegated `report_outcome` -> `end_call`. Prints the exact client messages and the structured outcome.

## Failure inspection

`data/calls/<task_id>.json` -> `events[]`: `request.received`, `call.initiated` (Twilio sid), then provider logs on stderr (`twilio.status`, `twilio.amd`, `openai_live.media.*`, `openai_live.session.*`, `openai_live.delegation`, `openai_live.tool_call`, `openai_live.needs_user`, `openai_live.call_ended`), then `call.completed|failed|voicemail`, `result.extracted`.
`raw_provider_result` carries `twilio`, `openai_session_id` (quote this to OpenAI support), `stream_sid`, `answered_by`, `end_reason`, `live_close_reason` (`close_requested | expired | content | remote_hangup | connection_lost`), `live_error`, `live_usage_seconds`, `latency`.
