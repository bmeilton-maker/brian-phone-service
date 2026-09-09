# xAI provider runbook

## What is verified (from docs and reference clients, Sept 2026)

| Item | Source | Status |
|---|---|---|
| Realtime WS `wss://api.x.ai/v1/realtime`, `Authorization: Bearer` | docs.x.ai voice-agent, mastra + sip-to-ai clients | verified |
| `session.update { model, voice, instructions, turn_detection:{type:"server_vad"}, audio }` | sip-to-ai `app/ai/grok_voice.py` | verified |
| Voices `eve` (default), `ara`, `rex`, `sal`, `leo` | docs.x.ai voice overview | verified |
| Events: `session.created`, `conversation.created`, `session.updated`, `input_audio_buffer.speech_started/stopped`, `conversation.item.input_audio_transcription.completed`, `response.output_audio.delta`, `response.output_audio_transcript.delta/done`, `response.done`, `error` | sip-to-ai client | verified |
| `response.create` with `metadata.client_event_id` | sip-to-ai client | verified |
| SIP: register Direct SIP number `POST https://api.x.ai/v2/phone-numbers` (`origin:"byo_trunk"`), returns webhook signing secret | docs.x.ai SIP page (search excerpt) | verified at excerpt level |
| Webhook `realtime.call.incoming`, headers `webhook-id`, `webhook-timestamp`, `webhook-signature`, payload `data.call_id` | docs.x.ai SIP page (search excerpt) | verified at excerpt level |
| Attach: `wss://api.x.ai/v1/realtime?call_id={call_id}` then `session.update`, then `response.create` | docs.x.ai SIP page (search excerpt) | verified at excerpt level |
| Twilio trunk origination `sip:{number}@sip.voice.x.ai;transport=tls` | docs.x.ai SIP page (search excerpt) | verified at excerpt level |
| Voice Agent Builder: no outbound-dial API found; outbound goes through your own SIP provider | x.ai builder posts, search excerpts | not found, treated as absent |

## Call topology (changed after the first live tests)

Twilio dials the xAI SIP number FIRST (parent leg). xAI answers at once and the session attaches with the greeting held. TwiML on that live leg then `<Dial>`s the human (child leg, `ParentCallSid` = our call_id). The callee is bridged into an already-answered line, so no ringback is played to them. The greeting fires on the child leg's `in-progress` callback.

Known cost of this ordering: the xAI SIP leg bills from the moment it answers, including the callee's ring time (typically 5 to 30 s). Server VAD should ignore ringback tones; if the agent ever starts talking before pickup, look for `response.create` before `twilio.status ... leg=pstn status=in-progress` in the logs and report it.

Stuck-call guards: `end_call` finalizes locally after hanging up (no dependency on Twilio's `completed` callback); a closed socket triggers a Twilio reconcile; `get_status` reconciles when callbacks have been quiet for `TWILIO_RECONCILE_AFTER_MS`. A rejected Twilio signature is now logged as `twilio.webhook.rejected` with the URL we expected. If you see that, `PUBLIC_BASE_URL` does not match what Twilio is calling.

## What must be confirmed on the first live call (marked `VERIFY` in code)

1. **Function calling shape.** Code sends `tools:[{type:"function",name,description,parameters}]` in `session.update`, reads `response.done -> response.output[].type=="function_call"` and `response.function_call_arguments.done`, replies with `conversation.item.create {type:"function_call_output", call_id, output}` then `response.create`. This is the OpenAI-Realtime-compatible shape the xAI docs say they mirror. Check `data/calls/<task>.json` events for `xai.tool_call`; if none appear on a completed call, dump raw events (set `LOG_LEVEL=debug`) and adjust `src/providers/xai/realtime.ts` `handle()`.
2. **Webhook signature scheme.** `src/providers/xai/webhook.ts` implements Standard Webhooks (`base64 HMAC-SHA256("id.timestamp.body")`, header `v1,<sig>`, `whsec_` secret). If xAI rejects with 401 in `xai.webhook.rejected`, compare with the docs' verification snippet.
3. **Task correlation.** The API `To` SIP URI carries `?X-Task-Id=`. If xAI surfaces SIP headers in `data.sip_headers` or `data.headers` we use them; otherwise we attach the oldest pending dial. Safe while calls are placed one at a time. If you ever run concurrent xai calls, confirm header passthrough first.
4. **Audio format on SIP calls.** For SIP, xAI owns the media leg, so `session.update` omits `audio`. If the session errors on missing audio config, add `audio:{input:{format:{type:"audio/pcmu",rate:8000}},output:{...}}`.
5. **DTMF.** Not implemented on the Twilio<->xAI bridge; `send_dtmf` returns `ok:false` and the agent asks for a representative. Options if IVR navigation matters: (a) Twilio `<Dial sendDigits>` pre-dial digits for known menus, (b) switch to Twilio Media Streams and bridge audio yourself (then DTMF via Twilio's API), (c) check whether xAI adds a DTMF event.
6. **Recording.** Not enabled on the bridge leg. Add `Record="true"` (and `RecordingStatusCallback`) to the Twilio dial form if you want a `recording_reference`, and confirm one-party consent rules in Ohio and the callee's state.
7. **Hangup.** `end_call` hangs up via Twilio `Status=completed`. If the SIP leg lingers, also close the WS (already done on end).

## Demo / dry run without any keys

```
npm run demo -- xai-session
```
Drives `XaiRealtimeSession` with a fake socket: envelope -> `session.update` -> transcript events -> `ask_owner` -> `report_outcome` -> `end_call`. Output shows the exact client messages and the structured outcome.

## Failure inspection

`data/calls/<task_id>.json` -> `events[]` in order: `request.received`, `call.initiated` (Twilio sid), then provider events logged on stderr (`twilio.status`, `twilio.amd`, `xai.webhook`, `xai.session_attached`, `xai.realtime.open`, `xai.tool_call`, `xai.needs_user`, `xai.call_ended`), then `call.completed|failed|voicemail`, `result.extracted`.
`raw_provider_result` carries `twilio`, `xai_incoming`, `answered_by`, `end_reason`, `realtime_error`.

## Alternative path if SIP correlation proves unreliable

Twilio Media Streams (`<Connect><Stream url="wss://PUBLIC/twilio-media">`) to this service, which relays G.711 audio to `wss://api.x.ai/v1/realtime?model=…` with `audio/pcmu` formats (the sip-to-ai client proves the format works). Deterministic correlation (stream `customParameters`), DTMF and recording via Twilio. More code (audio relay) but no dependency on xAI's SIP webhook. Not built; `XaiRealtimeSession` is reusable as is.
