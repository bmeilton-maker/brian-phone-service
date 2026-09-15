# brian-phone-service

Personal outbound phone-calling service for Brian, driven by Grok Bot (Chief of Staff / Ring).
Grok hands the service a small, task-scoped **call envelope**; the service places the call through a
provider, runs the conversation, and returns one **normalized structured result**.

```
Grok Chief of Staff -> phone MCP tools -> PhoneService -> { BlandProvider | XaiProvider | OpenAiLiveProvider | MockProvider } -> PSTN -> human
                                                     <- normalized result (summary + structured fields + transcript)
```

* **Default provider: `bland`** (proven, unchanged behavior). Switch with `PHONE_PROVIDER=xai|openai_live` or per call with `provider: "xai"` / `"openai_live"`.
* **Bland is never removed.** It is the fallback behind the same interface.
* **xAI provider**: Twilio dials the PSTN leg, bridges into xAI Direct SIP, and a Grok Voice realtime session runs the call with the envelope as `session.instructions` and in-call tools (`report_outcome`, `ask_owner`, `end_call`, `send_dtmf`, `note_hold`).
* **OpenAI GPT-Live-1 provider (`openai_live`, latency trial)**: Twilio dials the callee and opens a Media Stream to this service, which relays mu-law audio to OpenAI's Live Sessions WebSocket (`gpt-live-1`). Same envelope prompt, same greeting hold, tools via Responses delegation (`report_outcome`, `ask_owner`, `end_call`, `note_hold`). Runbook: **docs/OPENAI_LIVE_RUNBOOK.md**.
* **Mock provider**: scripted scenarios; runs the whole pipeline with no keys and no network. Used by tests, CI, and `npm run demo`.
* **Secrets are env-only.** Never in prompts, transcripts, logs, or stored records (the store and logger redact anything key-like).
* **Identity**: the agent always says it is Brian's AI assistant. It never claims to be Brian, never uses a cloned voice. xAI default voice is `eve`.

## Quick start

```bash
cp .env.example .env         # fill in BLAND_API_KEY at minimum
npm install
npm test                     # mocked regression suite (51 tests)
npm run demo                 # mock scheduling call, envelope -> result
npm run demo -- needs_user   # human-in-the-loop flow
npm run demo -- xai-session  # envelope -> xAI session.update -> tool calls -> structured outcome, no network
npm run demo -- openai-live-session  # envelope -> GPT-Live session.start -> delegated tools -> outcome, no network
npm run start:mcp            # MCP server on stdio (what Grok/Ring connects to)
npm run start:http           # HTTP API + webhooks on :8787
```

## How Grok / Ring calls it

### MCP (stdio)

Register `npm run start:mcp` from the repo root as an MCP server named `phone`.
Tools (provider-independent):

| Tool | Purpose |
|---|---|
| `phone_make_call` | Start a call. Returns `{task_id, call_id, status, provider, deduplicated}` immediately. |
| `phone_get_status` | `{state, started_at, duration_seconds, human_answered, voicemail, intervention_required, pending_question}` |
| `phone_get_result` | Normalized result once finished; `{pending:true,status}` while active. |
| `phone_cancel_call` | Hang up an active or queued call. |
| `phone_answer_question` | Deliver Brian's answer while the agent holds the line (`needs_user`; xai, openai_live and mock). |

Recommended Grok loop: `phone_make_call` -> poll `phone_get_status` every 15 to 30 s -> if `state == needs_user`, surface `pending_question` to Brian and call `phone_answer_question` -> on `completed|failed|cancelled` call `phone_get_result` and show `summary` (keep `transcript` and `raw_provider_result` for troubleshooting only).

### HTTP (same operations)

```
POST /calls                   body = examples/make_call.json          -> 202 {task_id, call_id, status}
GET  /calls/:id/status        :id = task_id or provider call_id
GET  /calls/:id/result
POST /calls/:id/cancel
POST /calls/:id/answer        {question_id, answer}
GET  /calls                   recent call list
GET  /healthz
```
Set `PHONE_SERVICE_TOKEN` and send `Authorization: Bearer <token>` if the port is reachable from outside localhost.

### Call envelope

Grok builds the envelope (`examples/call-envelope.json`); the service only ever receives the fields in `phone_make_call`. Rules baked into the prompt builder (`src/envelope.ts`):

* Anything not explicitly `true` in `authority` is **NO**. No pre-approved spend unless `may_authorize_amount_up_to` is a number.
* Personal details beyond the first name are disclosed only if listed in `may_disclose`.
* When a real choice is not settled by `preferences`, the agent does not guess. xAI: it holds and asks Brian (`ask_owner`, up to `NEEDS_USER_HOLD_SECONDS`), then falls back to callback number + reference. Bland: takes callback + reference and returns `questions_for_brian`.

### Normalized result

See `examples/normalized_result.json`. `status` is `success | partial | failed | needs_user`. Success means the objective and required outputs were achieved with no unauthorized commitment.
Extraction order: provider structured outcome (xAI `report_outcome` tool call) > text-model extraction from transcript (`XAI_EXTRACTION_MODEL`, only if `XAI_API_KEY` is set) > heuristic (regex) so mock/demo still returns full structure. Hard facts from the provider (voicemail, error) always cap the status.

## Configuration

| Var | Default | Notes |
|---|---|---|
| `PHONE_PROVIDER` | `bland` | `bland` / `xai` / `openai_live` / `mock`. Per-call `provider` overrides. |
| `BLAND_API_KEY` | | Required for Bland. |
| `BLAND_VOICE`, `BLAND_MODEL`, `BLAND_BACKGROUND_TRACK`, `BLAND_TEMPERATURE`, `BLAND_FROM_NUMBER` | `maya`, `base`, `office`, `0.5`, blank | Existing adapter settings. |
| `XAI_API_KEY` | | Required for xai provider and for LLM extraction. |
| `XAI_VOICE` | `eve` | Stock voice. Also `ara`, `rex`, `sal`, `leo`. |
| `XAI_REALTIME_MODEL` | `grok-voice-latest` | Realtime model alias. |
| `XAI_EXTRACTION_MODEL` | `grok-4-fast` | Text model for transcript -> result. |
| `XAI_SIP_NUMBER`, `XAI_WEBHOOK_SECRET` | | From registering a Direct SIP number (see docs/PROVISIONING.md). |
| `OPENAI_API_KEY` | | Required for the openai_live provider. |
| `OPENAI_LIVE_MODEL`, `OPENAI_LIVE_VOICE` | `gpt-live-1`, `marin` | Live voice model and voice. |
| `OPENAI_LIVE_BACKEND_MODEL` | `gpt-5.6-terra` | Responses-delegation backend that runs the tools (`gpt-5.6-luna` is cheaper). Optional `OPENAI_LIVE_BACKEND_REASONING_EFFORT`, `OPENAI_LIVE_BACKEND_SERVICE_TIER`. |
| `OPENAI_LIVE_GREETING_WAIT_MS`, `OPENAI_LIVE_HANGUP_DELAY_MS`, `OPENAI_LIVE_CLEAR_ON_BARGE_IN`, `OPENAI_LIVE_STORE` | `3000`, `3000`, `true`, `false` | Greeting hold, max wait for the goodbye to start before hangup, Twilio buffer clear on a substantive barge-in, keep a recording at OpenAI. |
| `OPENAI_LIVE_FAREWELL_HANGUP`, `OPENAI_LIVE_FAREWELL_SILENCE_MS` | `true`, `2500` | Hang up on farewell intent (agent goodbye sentence; callee goodbye + agent silence), not only on `end_call`. |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` | | Dials for xai (SIP leg first, then the human) and openai_live (callee + Media Stream). |
| `TWILIO_VALIDATE_SIGNATURE` | `true` | Verify `X-Twilio-Signature` on webhooks. Rejections are logged as `twilio.webhook.rejected` with the expected URL. |
| `TWILIO_RECONCILE_AFTER_MS` | `45000` | If no Twilio callback arrives for this long, `get_status` asks Twilio directly. |
| `PUBLIC_BASE_URL` | | Public HTTPS URL of this service; needed for xAI and Twilio webhooks and the openai_live media WebSocket. |
| `PHONE_SERVICE_TOKEN` | | Bearer token for the HTTP API. |
| `DATA_DIR` | `./data` | Call records (`data/calls/<task_id>.json`). |
| `DEFAULT_MAX_DURATION_SECONDS` | `600` | |
| `NEEDS_USER_HOLD_SECONDS` | `45` | How long the xAI agent waits for Brian's answer. |

The xai provider is registered only when every xAI/Twilio variable is present; otherwise the service logs `xai.not_configured` and keeps running on Bland. Likewise `openai_live` needs `OPENAI_API_KEY` + Twilio + `PUBLIC_BASE_URL` or it logs `openai_live.not_configured`.

## Current Bland behavior (preserved as `BlandProvider`)

`src/providers/bland.ts`, verified against https://docs.bland.ai/api-v1/post/calls, `/api-v1/get/calls-id`, `/api-v1/post/calls-id-stop`.

1. `POST https://api.bland.ai/v1/calls` with header `authorization: <BLAND_API_KEY>` and body
   `phone_number, task, first_sentence, voice, model, wait_for_greeting=true, interruptibility=3, background_track, temperature, record=true, max_duration (minutes), voicemail.action="leave_message", metadata{task_id}`.
   `task` is the envelope rendered by `buildAgentInstructions` (same text xAI gets, minus tool notes). `first_sentence` identifies the caller as Brian's AI assistant.
2. Poll `GET /v1/calls/:id` every `BLAND_POLL_INTERVAL_MS` (5 s) until `completed`.
3. Map `status / completed / queue_status -> state`, `answered_by -> human_answered / voicemail`, `summary -> provider summary`, `transcripts[] + concatenated_transcript -> transcript`, `recording_url`, `price`, `call_length (min) -> duration_seconds`, `error_message -> error`.
4. Cancel: `POST /v1/calls/:id/stop`.

Bland cannot hold the line for a live answer, so `needs_user` on Bland always means: callback captured, `questions_for_brian` populated, call ended.

## xAI provider (Grok Voice Agent API)

`src/providers/xai/`. Full runbook with what is verified vs. still to confirm: **docs/XAI_RUNBOOK.md**.

Outbound path (xAI SIP is inbound-first; there is no documented "dial this PSTN number" API, so Twilio dials). SIP-first ordering so the callee never hears ringback:

1. `TwilioClient.dial` -> `POST /2010-04-01/Accounts/{sid}/Calls.json` with `To=sip:{XAI_SIP_NUMBER}@sip.voice.x.ai;transport=tls?X-Task-Id=…` (parent leg). xAI answers immediately.
2. xAI POSTs `realtime.call.incoming` to `PUBLIC_BASE_URL/webhooks/xai` (signature verified). `XaiProvider.handleXaiIncoming` matches the pending task, opens `wss://api.x.ai/v1/realtime?call_id=…`, sends `session.update` (voice, instructions from the envelope, `server_vad`, tools). The greeting is held.
3. TwiML on the answered SIP leg runs `<Dial><Number statusCallback=… machineDetection="Enable">{callee}</Number></Dial>` (child leg). The callee is dialed from a live line and is bridged to the agent the moment they pick up.
4. Child-leg `in-progress` callback releases `response.create`; the agent greets. Transcripts stream in; tool calls are dispatched (`report_outcome` becomes the structured base of the result; `end_call` hangs up via Twilio and finalizes locally; `ask_owner` holds for Brian).
5. Child-leg `completed` (with Twilio's `CallDuration`), the parent `completed`, a closed socket, or a quiet-callback reconcile against Twilio finalizes; `PhoneService` runs extraction and persists. `duration_seconds` is talk time only (human answered to ended).

## OpenAI GPT-Live-1 provider (`openai_live`)

`src/providers/openai_live/`. Runbook with the chosen path, what is verified, and what to confirm on the first live call: **docs/OPENAI_LIVE_RUNBOOK.md**.

1. `POST /Calls.json` `To={callee}` with inline TwiML `<Connect><Stream url="wss://PUBLIC/webhooks/openai-live/media"><Parameter name="task_id"/></Stream></Connect>`, async AMD, status callbacks on `/webhooks/openai-live/twilio/*`. One leg; our call_id = Twilio CallSid.
2. Callee answers -> Twilio opens the Media Stream to us -> we open `wss://api.openai.com/v1/live/sessions`, send `session.start` (`audio/pcmu` 8 kHz, Responses delegation) and relay mu-law both ways unchanged. Two prompt layers per OpenAI's GPT-Live guides: the live model gets OpenAI's live-prompting template customized for Brian (`buildLiveInstructions`: calling on behalf of Brian, style, purpose, greeting hold, `Backchannel` / `Interruption` / `Delegation policy`); the backend model gets the full `buildAgentInstructions` envelope (context, preferences, authority, required outputs) plus the tool schemas.
3. Greeting hold: GPT-Live waits for the human natively; if nobody speaks for `OPENAI_LIVE_GREETING_WAIT_MS` we prompt it to open (`session.instructions.append` + `session.commentary.append`). Turn-taking and interruptions are handled by the full-duplex model (no VAD knobs).
4. Tools arrive as `response.event -> response.output_item.done (function_call)`; this service executes them (it owns permissions and state) and answers with `response.item.create` + `response.create`. `ask_owner` holds for Brian (`needs_user`). Results that arrive after the session started closing are marked stale and not fed back.
5. Hangup is owned by the bridge, not the model. `end_call` from the backend, the agent's own goodbye sentence, or a callee goodbye followed by agent silence all run the same sequence: let one goodbye finish, mute callee audio so the model cannot take another farewell turn, wait for Twilio's `mark` (audio really played), hang up via Twilio about half a second after the last goodbye word. Only then, with the callee gone, does the OpenAI session linger briefly to collect a `report_outcome` the backend was still producing, before the record is finalized. A callee who interrupts the goodbye with real content cancels the close; the next goodbye starts it again. Details and knobs in the runbook.
5. Twilio `completed`, stream stop, `session.closed`, or a quiet-callback reconcile finalizes. `raw_provider_result.latency` records setup, first-audio, per-turn and delegation latencies for the A/B against xAI.

Trial: `"provider": "openai_live"` per call (`examples/make_call_openai_live_override.json`), or `PHONE_PROVIDER=openai_live` process-wide. xAI and Bland stay available.

## Migration plan (Bland -> xAI)

1. Keep `PHONE_PROVIDER=bland`. Nothing changes for Ring.
2. Provision xAI + Twilio per **docs/PROVISIONING.md**. Start the HTTP listener with a public URL.
3. Run one xai call with a per-call override (`examples/make_call_xai_override.json`) against your own phone. Inspect `data/calls/<task_id>.json` end to end.
4. Run **docs/SIDE_BY_SIDE_CHECKLIST.md**: same envelope, both providers, score each row.
5. When xAI wins on task success and reliability: set `PHONE_PROVIDER=xai`, restart. Config-only flip. Bland stays available via `provider: "bland"` and as the fallback if xai preflight fails at startup.
6. Roll back by setting `PHONE_PROVIDER=bland`.

## Observability

Structured JSON logs on stderr (no secrets): provider request, initiation, ringing/answer/voicemail/failure, in-call tool calls, transcript turns (debug), extraction timing, provider errors, cost when the provider reports it.
Every call is persisted as `data/calls/<task_id>.json` with `request`, `envelope`, `status`, `events[]`, and `result`. Failed calls are inspectable end to end from that one file.

## Error handling

| Situation | Bland | xAI |
|---|---|---|
| Busy / no answer | `answered_by`/`error_message` -> `failed`, error `busy`/`no_answer` | Twilio status -> `failed` |
| Voicemail | `answered_by=voicemail`, message left -> `partial` | AMD `machine_*` -> `partial`; agent instructed to leave a message |
| Invalid number | rejected pre-dial (E.164 check) or API error -> `failed` | same |
| Dropped call | `completed` with short transcript -> extraction marks `partial/failed` | Twilio `completed` early; `no_transcript` error if nothing captured |
| Provider timeout | poll continues to `max_duration`; then finalized with what exists | safety net polls Twilio after `max_duration + 60s` |
| API error | thrown at start -> record `failed`, result has error summary | same |
| Wrong person | prompt: apologize, end -> `failed`, `human_or_business_reached` = wrong number | same |
| IVR loop | prompt: after two loops ask for a rep or end | same plus `send_dtmf` (see runbook: not yet supported on the SIP bridge) |
| Prolonged hold | Bland handles natively up to `max_duration` | `note_hold` tool; instructed hang-up threshold |
| Outside authority | prompt: decline, take callback, `questions_for_brian` | `ask_owner` hold, then callback fallback |

## Testing

* `npm test`: 51 mocked tests covering the 10 brief scenarios, error cases, idempotency, persistence, Bland API shape, xAI webhook signing, xAI session/tool flow, GPT-Live session/media relay/delegated tools/greeting hold, needs_user hold and timeout, cancel, provider override, HTTP webhook + WebSocket routing.
* `npm run demo -- <scenario>`: any mock scenario end to end.
* Live PSTN tests are manual: **docs/SIDE_BY_SIDE_CHECKLIST.md**.

## Adding a provider (Retell etc.)

Implement `PhoneProvider` (`src/types.ts`: `startCall`, `getOutcome`, `cancelCall`, optional `answerQuestion`), register it in `src/bootstrap.ts`, add the name to `ProviderName`. Nothing above `PhoneService` changes.

## Layout

```
src/types.ts            envelope, result, provider interface
src/envelope.ts         envelope + one prompt builder for all providers (+ short GPT-Live conversation prompt)
src/extraction.ts       transcript -> normalized result
src/service.ts          PhoneService (idempotency, polling, needs_user, persistence)
src/store.ts            file-backed call history with redaction
src/providers/bland.ts  BlandProvider (unchanged API shape)
src/providers/xai/      Twilio dial, webhook verify, realtime session, provider
src/providers/openai_live/  GPT-Live session (WS protocol, tools, greeting hold, latency), Media Streams bridge provider
src/providers/mock.ts   scripted scenarios
src/server/http.ts      HTTP API + webhooks + Media Streams WebSocket
src/server/mcp.ts       MCP stdio server
src/cli/demo.ts         dry-run demos
docs/                   provisioning, xAI runbook, OpenAI Live runbook, side-by-side checklist
examples/               envelope, make_call payloads, result
```
