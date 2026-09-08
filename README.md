# brian-phone-service

Personal outbound phone-calling service for Brian, driven by Grok Bot (Chief of Staff / Ring).
Grok hands the service a small, task-scoped **call envelope**; the service places the call through a
provider, runs the conversation, and returns one **normalized structured result**.

```
Grok Chief of Staff -> phone MCP tools -> PhoneService -> { BlandProvider | XaiProvider | MockProvider } -> PSTN -> human
                                                     <- normalized result (summary + structured fields + transcript)
```

* **Default provider: `bland`** (proven, unchanged behavior). Switch with `PHONE_PROVIDER=xai` or per call with `provider: "xai"`.
* **Bland is never removed.** It is the fallback behind the same interface.
* **xAI provider**: Twilio dials the PSTN leg, bridges into xAI Direct SIP, and a Grok Voice realtime session runs the call with the envelope as `session.instructions` and in-call tools (`report_outcome`, `ask_owner`, `end_call`, `send_dtmf`, `note_hold`).
* **Mock provider**: scripted scenarios; runs the whole pipeline with no keys and no network. Used by tests, CI, and `npm run demo`.
* **Secrets are env-only.** Never in prompts, transcripts, logs, or stored records (the store and logger redact anything key-like).
* **Identity**: the agent always says it is Brian's AI assistant. It never claims to be Brian, never uses a cloned voice. xAI default voice is `eve`.

## Quick start

```bash
cp .env.example .env         # fill in BLAND_API_KEY at minimum
npm install
npm test                     # mocked regression suite (31 tests)
npm run demo                 # mock scheduling call, envelope -> result
npm run demo -- needs_user   # human-in-the-loop flow
npm run demo -- xai-session  # envelope -> xAI session.update -> tool calls -> structured outcome, no network
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
| `phone_answer_question` | Deliver Brian's answer while the agent holds the line (`needs_user`; xai and mock). |

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
| `PHONE_PROVIDER` | `bland` | `bland` / `xai` / `mock`. Per-call `provider` overrides. |
| `BLAND_API_KEY` | | Required for Bland. |
| `BLAND_VOICE`, `BLAND_MODEL`, `BLAND_BACKGROUND_TRACK`, `BLAND_TEMPERATURE`, `BLAND_FROM_NUMBER` | `maya`, `base`, `office`, `0.5`, blank | Existing adapter settings. |
| `XAI_API_KEY` | | Required for xai provider and for LLM extraction. |
| `XAI_VOICE` | `eve` | Stock voice. Also `ara`, `rex`, `sal`, `leo`. |
| `XAI_REALTIME_MODEL` | `grok-voice-latest` | Realtime model alias. |
| `XAI_EXTRACTION_MODEL` | `grok-4-fast` | Text model for transcript -> result. |
| `XAI_SIP_NUMBER`, `XAI_WEBHOOK_SECRET` | | From registering a Direct SIP number (see docs/PROVISIONING.md). |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` | | Dials the PSTN leg for xai. |
| `PUBLIC_BASE_URL` | | Public HTTPS URL of this service; needed for xAI and Twilio webhooks. |
| `PHONE_SERVICE_TOKEN` | | Bearer token for the HTTP API. |
| `DATA_DIR` | `./data` | Call records (`data/calls/<task_id>.json`). |
| `DEFAULT_MAX_DURATION_SECONDS` | `600` | |
| `NEEDS_USER_HOLD_SECONDS` | `45` | How long the xAI agent waits for Brian's answer. |

The xai provider is registered only when every xAI/Twilio variable is present; otherwise the service logs `xai.not_configured` and keeps running on Bland.

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

Outbound path (xAI SIP is inbound-first; there is no documented "dial this PSTN number" API, so Twilio dials):

1. `TwilioClient.dial` -> `POST /2010-04-01/Accounts/{sid}/Calls.json` with TwiML `<Dial answerOnBridge="true"><Sip>sip:{XAI_SIP_NUMBER}@sip.voice.x.ai;transport=tls?X-Task-Id=…</Sip></Dial>`, status callbacks, async AMD (voicemail detection).
2. xAI receives the bridged SIP leg and POSTs `realtime.call.incoming` to `PUBLIC_BASE_URL/webhooks/xai` (signature verified).
3. `XaiProvider.handleXaiIncoming` matches the pending task, opens `wss://api.x.ai/v1/realtime?call_id=…`, sends `session.update` (voice, instructions from the envelope, `server_vad`, tools) and `response.create`.
4. The agent talks; transcripts stream in; tool calls are dispatched (`report_outcome` becomes the structured base of the result; `end_call` hangs up via Twilio; `ask_owner` holds for Brian).
5. Twilio `completed` callback (or timeout safety net) finalizes; `PhoneService` runs extraction and persists.

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

* `npm test`: 31 mocked tests covering the 10 brief scenarios, error cases, idempotency, persistence, Bland API shape, xAI webhook signing, xAI session/tool flow, needs_user hold and timeout, cancel, provider override.
* `npm run demo -- <scenario>`: any mock scenario end to end.
* Live PSTN tests are manual: **docs/SIDE_BY_SIDE_CHECKLIST.md**.

## Adding a provider (Retell etc.)

Implement `PhoneProvider` (`src/types.ts`: `startCall`, `getOutcome`, `cancelCall`, optional `answerQuestion`), register it in `src/bootstrap.ts`, add the name to `ProviderName`. Nothing above `PhoneService` changes.

## Layout

```
src/types.ts            envelope, result, provider interface
src/envelope.ts         envelope + one prompt builder for all providers
src/extraction.ts       transcript -> normalized result
src/service.ts          PhoneService (idempotency, polling, needs_user, persistence)
src/store.ts            file-backed call history with redaction
src/providers/bland.ts  BlandProvider (unchanged API shape)
src/providers/xai/      Twilio dial, webhook verify, realtime session, provider
src/providers/mock.ts   scripted scenarios
src/server/http.ts      HTTP API + webhooks
src/server/mcp.ts       MCP stdio server
src/cli/demo.ts         dry-run demos
docs/                   provisioning, xAI runbook, side-by-side checklist
examples/               envelope, make_call payloads, result
```
