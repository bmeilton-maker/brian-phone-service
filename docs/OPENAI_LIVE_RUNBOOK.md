# OpenAI GPT-Live-1 provider runbook (`openai_live`)

Purpose: A/B GPT-Live-1 against xAI on response latency with the same envelope, same Twilio number, same MCP tools.
Nothing about Bland or xAI changes; `openai_live` is a third provider behind `PhoneService`.

Sources followed: developers.openai.com guides `live` (getting started), `live-prompting`, `live-delegation`, `live-conversations`, `voice-websockets`, `voice-sip`, `live-partner-integrations`; Twilio's GPT-Live-1 Media Streams outbound tutorial and the Twilio Agent Connect `GPTLiveProvider` post (all Sept 2026).

## Architecture: two layers

| Layer | What it holds | Where in code |
|---|---|---|
| **GPT-Live (`gpt-live-1`)**: listens, speaks, full duplex, decides when to delegate | OpenAI's live-prompting template, customized for Brian's outbound household calls (~450 tokens): "You are calling {recipient} on behalf of Brian", style, busy/frustrated handling, AI-assistant identity, the purpose of the call, the opening rule (silent until greeted, one short sentence then pause), voicemail / wrong-number controls, the closing rule (delegate first, exactly one goodbye, stop; never repeat it or ask "anything else?"), then the verbatim policy labels: `Backchannel policy`, `Interruption policy`, `Delegation policy` with `Backend tools` (outcome reporting + hangup; authority checks and structured facts from the envelope; asking Brian), `Delegate to the backend when` (record outcome / hang up; careful reasoning, tools or authority beyond conversation; a correction changes work already requested; on hold), `Do not delegate to the backend when` (greetings, small talk, repeating a still-current result; brief clarification), and the three closing lines (delegate before answering, do not guess, do not promise a booking/price/action before the backend confirms). No context, preferences, authority table, required outputs or tool names. | `buildLiveInstructions` in `src/envelope.ts` |
| **Backend (Responses delegation, `OPENAI_LIVE_BACKEND_MODEL`)**: reasoning, tools, business rules | The full envelope from `buildAgentInstructions` (objective, RELEVANT CONTEXT, PREFERENCES, AUTHORITY, REQUIRED OUTPUTS, tool note) plus how to serve the live model (fact/preference/choice questions, authority questions, ask_owner relay, report_outcome then end_call, hold, stale requests); the tool schemas `report_outcome` (RESULT_JSON_SCHEMA), `ask_owner`, `end_call`, `note_hold` in `delegation.responses.tools`. | `backendInstructionsAddendum`, `backendTools` in `src/providers/openai_live/live.ts` |
| **This service (application)**: permissions, confirmations, private function execution, durable state, **hangup** | Executes every tool: `ask_owner` is the `needs_user` hold (`phone_answer_question`), `report_outcome` becomes the structured result, the call record in `data/calls/` is the durable task state. Owns the close: `end_call`, the agent's goodbye sentence, or a callee goodbye + agent silence all run the same hangup sequence (see "Hangup on farewell"). Backend results that arrive after the session started closing are marked stale (`raw.stale_results`, logged `openai_live.stale_tool_result`) and kept out of the live model. Interrupting speech never cancels backend work; the backend prompt tells it to act on the latest request and never repeat `report_outcome` / `end_call`. | `OpenAiLiveProvider.closeCall`, `OpenAiLiveSession.dispatchTool`, `farewell.ts` |

Consequence to watch on the trial: because facts, preferences and authority live only in the backend, questions like "which day works?" or "date of birth?" cost one delegation round trip (`delegation_roundtrips_ms`, typically 1 to 3 s; the live model says "one moment" meanwhile). That is the pattern OpenAI recommends and it keeps the live prompt small. If those round trips dominate `turn_latencies_ms`, the lever is `OPENAI_LIVE_BACKEND_MODEL=gpt-5.6-luna` / `OPENAI_LIVE_BACKEND_REASONING_EFFORT=low` / `OPENAI_LIVE_BACKEND_SERVICE_TIER=priority`, not moving facts back into the live prompt.

Responses delegation was chosen over client delegation because our backend needs are exactly the managed loop (one model, four function tools). Client delegation would only add value if we wanted to route to a non-OpenAI model or pre-filter results; it is a session-start switch (`delegation.type`) if that changes.

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

**Twilio Agent Connect `GPTLiveProvider`**: evaluated. It is Twilio's Python SDK (`twilio-agent-connect[server,gpt-live]`, FastAPI) that wraps exactly this Media Streams bridge (`session.start` with `audio/pcmu` 8 kHz, Responses delegation, `initiate_outbound_conversation(to=...)`). This service is Node/TypeScript with its own call-state, idempotency and MCP layer, so we implement the same bridge directly (`src/providers/openai_live/`) instead of running a second Python process. Their post confirms the two properties we rely on: GPT-Live handles interruption logic itself (no barge-in bookkeeping) and its audio format natively matches Twilio's wire format.

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
| Voices: `willow` (our default), `marin` (OpenAI default), `gleam`, `meridian`, `quartz`, `ripple`, `vesper`, `stone`, `delta`, `cinder`, ... | verified |
| Live prompt template: short role/style, `Backchannel policy`, `Interruption policy`, `Delegation policy` with `Backend tools` / `Delegate to the backend when` / `Do not delegate to the backend when`; "Delegate before giving an answer that depends on backend work. Do not guess the result while waiting." | verified (live-prompting), applied in `buildLiveInstructions` |
| Twilio Agent Connect `GPTLiveProvider` = Python SDK over the same Media Streams bridge; outbound via `initiate_outbound_conversation` | verified (Twilio post), not used (Node service) |
| Twilio: `POST /Calls.json` with inline `Twiml=<Connect><Stream>`, `<Parameter>` custom params, `MachineDetection=Enable AsyncAmd=true AsyncAmdStatusCallback`, `Timeout`, `TimeLimit` | verified (Twilio docs / tutorial) |
| Twilio Media Streams frames: `connected`, `start{streamSid,callSid,customParameters}`, `media{payload,track}`, `stop`, `dtmf`; we send `media{streamSid,payload}` and `clear{streamSid}` | verified |

## Env

```
PHONE_PROVIDER=xai                # leave as is; flip per call first (see below)
OPENAI_API_KEY=sk-...             # project key with gpt-live-1 + backend model access
OPENAI_LIVE_MODEL=gpt-live-1
OPENAI_LIVE_VOICE=willow
OPENAI_LIVE_BACKEND_MODEL=gpt-5.6-terra      # docs: start here; gpt-5.6-luna is cheaper
OPENAI_LIVE_BACKEND_REASONING_EFFORT=        # optional, e.g. low
OPENAI_LIVE_BACKEND_SERVICE_TIER=            # optional, priority = Fast mode if enabled on the project
OPENAI_LIVE_GREETING_WAIT_MS=3000
OPENAI_LIVE_HANGUP_DELAY_MS=3000             # max wait for the goodbye audio to start (covers one backend round trip)
OPENAI_LIVE_FAREWELL_HANGUP=true             # hang up on goodbye intent, not only on end_call
OPENAI_LIVE_FAREWELL_SILENCE_MS=2500         # callee said goodbye + agent silent this long -> hang up (x2 while the backend is mid-request)
OPENAI_LIVE_CLEAR_ON_BARGE_IN=true           # drop Twilio's queued agent audio on a substantive interruption
OPENAI_LIVE_STORE=false
# reused: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER, PUBLIC_BASE_URL, NEEDS_USER_HOLD_SECONDS
```

Voice: default `willow` (Brian's pick after the trial; `gleam` was used for the latency trial, `marin` is OpenAI's neutral default). Override process-wide with `OPENAI_LIVE_VOICE` or per call with `preferred_voice` in `phone_make_call` (e.g. `gleam` / `meridian` for a North American feminine / masculine voice). The voice is fixed at session start. `OPENAI_API_KEY` is read only in this process (`session.start` over the server WebSocket); it is never sent to Twilio or written to call records.

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
3. Interrupt it mid-sentence with a real sentence ("wait, which day?"): it should stop within a beat. GPT-Live stops generating on its own; `OPENAI_LIVE_CLEAR_ON_BARGE_IN=true` (default) additionally drops the audio already queued at Twilio, but only for substantive speech, never for "mm-hm" / "okay". If it cuts you off wrongly, set it to `false`.
4. Finish the task. It says one goodbye and the line drops about a second after the goodbye finishes (`tail_after_goodbye_ms` in the `openai_live.hangup` log line; anything over ~2 s means Twilio did not echo the mark in time). Say "bye" over its goodbye: no second farewell turn should follow. Say "wait, one more thing" over its goodbye: it should stop, answer, and close again after the next goodbye.
5. Say goodbye yourself and then stay quiet: if the agent does not answer with its own goodbye, the line drops after `OPENAI_LIVE_FAREWELL_SILENCE_MS`.

## Hangup on farewell (why the call did not end on the Sep 15 trial, and what ends it now)

On the first trial the agent said goodbye, nothing hung up, and the callee's "bye" produced another farewell turn. Hangup depended on a three-hop chain: the live model had to *choose* to delegate after its goodbye (a goodbye looks like "small talk", which the prompt told it not to delegate), the backend then had to call `report_outcome`, and only after our `response.create` would it call `end_call`, whose description said "only after the assistant has said goodbye" (so when the live model delegated first, the backend recorded the outcome and asked it to say goodbye and come back: another turn, another delegation). Meanwhile the bridge kept forwarding the callee's audio, so every "bye" was a new turn for the model.

The bridge now owns the close (`OpenAiLiveProvider.closeCall`, `src/providers/openai_live/farewell.ts`). Triggers, any of which is enough:

| Trigger | `raw.close_trigger` | Notes |
|---|---|---|
| Backend calls `end_call` | `end_call` | `end_call` output is answered with `response.create` so the backend can hand the live model its goodbye line (unless the goodbye already played). |
| The agent's last sentence is a goodbye and not a question (`isClosingLine`) | `agent_farewell` | Detected on the running output transcript; re-checked once the audio stops ("before we say goodbye, which day?" is abandoned, `openai_live.close_abandoned`). |
| The callee says goodbye and the agent stays silent for `OPENAI_LIVE_FAREWELL_SILENCE_MS` (doubled while a delegation is in flight) | `human_farewell` | Callee "bye" alone does nothing while the agent answers; this only catches a dead line. Ignored before the agent has spoken at all (a voicemail greeting's "have a great day") and whenever AMD reported a machine. |

Sequence (`openai_live.closing` -> `openai_live.hangup` -> `openai_live.call_ended`). Budget on the callee's clock after the last goodbye word: **~0.5 s quiet detection + Twilio playout of what is still buffered + one Twilio REST call**, typically 1 to 1.5 s. Nothing in the sequence waits on the backend before the line drops.

1. **goodbye**: wait up to `OPENAI_LIVE_HANGUP_DELAY_MS` (3 s) for the agent's goodbye audio to start, then until it has been quiet for 500 ms (cap 8 s). A callee interruption with content ("wait", "which Tuesday?") cancels here (`openai_live.close_cancelled`, `raw.close_cancels`), acknowledgements and farewells ("okay", "thanks, bye") do not; after 2 cancels the close is firm. `end_call` while the agent is not speaking and says nothing more hangs up when the wait expires. For the `human_farewell` trigger there is no start wait: only audio already flowing is allowed to finish.
2. **done**: callee audio is no longer forwarded to the model (`inputMuted`), so a "bye" back cannot start another farewell turn, and no tool result triggers `response.create` any more. `raw.goodbye_done_ms`.
3. **playout**: a Twilio `mark` is queued behind the goodbye audio; Twilio echoes it when the callee has actually heard it (cap 1.5 s). Our socket being quiet is not the same thing.
4. **hangup**: the Media Stream socket is closed (Twilio ends a `<Connect><Stream>` call the moment its stream closes, no REST latency) and the REST hangup is sent in parallel as the authoritative fallback (`raw.hangup_at`, `raw.close_ms` = trigger -> hangup; the log line `openai_live.hangup` carries `tail_after_goodbye_ms`). The callee's call is over here.
5. **collect** (callee already gone): if no `report_outcome` was recorded, the OpenAI session stays open up to 1.5 s (5 s when a delegation is in flight) for the backend to deliver it; Twilio's `completed` callback and the stream `stop` that follow our hangup do not finalize the record early. Then `session.close` and the record is final (`raw.collect_ms`). `raw.end_reason` is the backend's `end_call` reason when it came, else `agent_said_goodbye` / `callee_said_goodbye`.

Prompt side: the live prompt has a `Closing:` rule (delegate first, one goodbye, stop; never repeat, never "anything else?"; if interrupted, answer then close again) and the do-not-delegate list excludes goodbyes; the backend is told to do `report_outcome` -> `end_call` -> the one goodbye sentence in a single turn and never to send the assistant back for a second goodbye. These make the *normal* path (`end_call` before the goodbye) the common one; the farewell triggers are the guarantee when the model skips it.

Unrelated to farewells but the same "line stays open" family: if OpenAI drops the session (`live_close_reason` `expired` / `connection_lost` / error) while Twilio is still `in-progress`, the callee leg is hung up immediately and the call ends `failed` with `error: live_session_closed:<reason>` (or `completed` if `report_outcome` had already landed), instead of dead air until `TimeLimit` (`openai_live.session_dropped`).

Kill switch: `OPENAI_LIVE_FAREWELL_HANGUP=false` returns to `end_call`-only hangup (still with the goodbye drain and mark).

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

1. **Delegation triggers.** The live prompt tells GPT-Live to delegate to record the outcome / hang up, for anything needing reasoning, tools or authority (commitments, payment, cancellation, personal details, Brian's choice), for corrections, and when on hold. If a completed call has no `openai_live.tool_call report_outcome`, the live model did not delegate: tighten the `Delegate to the backend when:` conditions in `buildLiveInstructions` (`src/envelope.ts`); keep the label format from OpenAI's prompting guide and do not add a second policy block. If it delegates too eagerly (a backend round trip before simple answers), extend `Do not delegate to the backend when:` instead.
2. **Goodbye vs hangup.** See "Hangup on farewell". Check `raw.close_trigger`: `end_call` means the prompt path worked; `agent_farewell` means the live model closed without delegating (outcome then comes from the 2 s post-goodbye window or transcript extraction); `human_farewell` means the agent went silent after the callee's goodbye. If the goodbye is clipped, `raw.close_ms` minus `raw.goodbye_done_ms` shows whether Twilio echoed the mark (well under 1500) or we timed out; if the line hangs a beat too long after the goodbye, that difference plus `goodbyeQuietMs` is the tail (`defaultCloseTiming` in `index.ts`); the outcome windows run after hangup and cannot be the cause. If a legitimate goodbye is not detected, add the phrase to `FAREWELL_RE` in `farewell.ts` (keep word boundaries).
3. **Function-call item shape.** We read `response.event.event.item` with `type:"function_call"`, `status:"completed"`, `call_id`, `name`, `arguments` (docs). If `openai_live.tool_call` never logs but `openai_live.delegation` does, set `LOG_LEVEL=debug` and inspect the nested event types.
4. **Turn grouping.** Transcript turns are grouped on `start_ms`/`end_ms` (300 ms overlap tolerance, 1.5 s same-speaker gap). If turns look chopped or merged in `transcript`, tune `TURN_*` constants in `live.ts`.
5. **Voicemail.** Async AMD posts `AnsweredBy=machine_*` a few seconds after pickup; we then `session.instructions.append` a leave-a-message instruction. GPT-Live may already have started listening to the greeting; check the message actually lands after the beep.
6. **DTMF.** Not available on a Media Streams bridge (`send_dtmf` is omitted from the tool list; the prompt says to ask for a representative). Inbound key presses are logged as system turns.
7. **Recording.** Twilio recording is not enabled. `OPENAI_LIVE_STORE=true` keeps a 30-day stereo WAV at OpenAI (`GET /v1/live/sessions/{id}/content`, `recording_reference` is set) if the project allows storage; check consent rules first.
8. **Tunnel WebSocket**. If the call connects but stays silent, the tunnel is not passing the WS upgrade or `PUBLIC_BASE_URL` is wrong. Look for `openai_live.media.connected`; Twilio Console -> call -> Media Streams shows the URL it tried.
9. **Stale results.** `raw.stale_results` lists backend tool results that arrived after the session started closing (e.g. Brian answered after the callee hung up). Expected occasionally; if it shows `report_outcome`, the outcome was still recorded in the result, only not spoken.

## If Media Streams proves too laggy

Switch to OpenAI Direct SIP with the xAI topology: Twilio dials `sip:$PROJECT_ID@sip.api.openai.com;transport=tls` first, our `live.transport.incoming` webhook accepts with `POST /v1/live/sessions/{session_id}/accept` (same session config minus `audio.format`), we attach a sideband at `wss://api.openai.com/v1/live/sessions/{session_id}/attach`, then TwiML `<Dial>`s the human. `OpenAiLiveSession` is reusable as is (skip `session.start`, keep everything else). Hangup via `POST /v1/live/sessions/{id}/hangup`. Requires enabling SIP on the project and a webhook secret. Not built.

## Dry run without keys

```
npm run demo -- openai-live-session
```
Drives `OpenAiLiveSession` with a fake socket: envelope -> `session.start` -> transcript fragments -> delegated `report_outcome` -> `end_call`. Prints the exact client messages and the structured outcome.

## Failure inspection

`data/calls/<task_id>.json` -> `events[]`: `request.received`, `call.initiated` (Twilio sid), then provider logs on stderr (`twilio.status`, `twilio.amd`, `openai_live.media.*`, `openai_live.session.*`, `openai_live.delegation`, `openai_live.tool_call`, `openai_live.needs_user`, `openai_live.call_ended`), then `call.completed|failed|voicemail`, `result.extracted`.
`raw_provider_result` carries `twilio`, `openai_session_id` (quote this to OpenAI support), `stream_sid`, `answered_by`, `end_reason`, `close_trigger` (`end_call | agent_farewell | human_farewell`), `goodbye_done_ms`, `hangup_at`, `close_ms`, `collect_ms`, `close_cancels`, `live_close_reason` (`close_requested | expired | content | remote_hangup | connection_lost`), `live_error`, `live_usage_seconds`, `latency`. Closing logs: `openai_live.farewell` (who said goodbye), `openai_live.closing`, `openai_live.hangup` (with `tail_after_goodbye_ms`), `openai_live.collect_timeout`, `openai_live.close_cancelled`, `openai_live.close_abandoned`, `openai_live.farewell_silence`, `openai_live.session_dropped`.
