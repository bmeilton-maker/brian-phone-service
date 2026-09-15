import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { createHttpServer } from "../src/server/http.js";
import { OpenAiLiveProvider, dialForm, mediaStreamTwiml, type CloseTiming, type MediaWsLike } from "../src/providers/openai_live/index.js";
import { OpenAiLiveSession, LIVE_TOOL_NAMES } from "../src/providers/openai_live/live.js";
import { classifyHumanUtterance, containsFarewell, isClosingLine } from "../src/providers/openai_live/farewell.js";
import { TwilioClient, type TwilioHttp } from "../src/providers/xai/twilio.js";
import { FakeWs } from "../src/providers/xai/fakews.js";
import { buildEnvelope } from "../src/envelope.js";
import { assertProvider, config } from "../src/config.js";
import { PhoneService } from "../src/service.js";
import { CallStore } from "../src/store.js";
import type { NormalizedResult } from "../src/types.js";

// Configure openai_live for tests (no network is ever hit; Twilio, the OpenAI socket and the Twilio media socket are faked).
Object.assign(config.openaiLive, { apiKey: "sk-test-key", greetingWaitMs: 60, hangupDelayMs: 0, store: false, farewellHangup: true, farewellSilenceMs: 120 });
Object.assign(config.twilio, { accountSid: "ACtest", authToken: "tok", fromNumber: "+16145550000" });
(config as { publicBaseUrl: string }).publicBaseUrl = "https://example.test";
(config as { needsUserHoldSeconds: number }).needsUserHoldSeconds = 0.05;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Server-side Twilio Media Streams socket stand-in: records what we send to Twilio, lets tests inject Twilio frames. */
class FakeMediaWs extends EventEmitter implements MediaWsLike {
  sent: string[] = [];
  closed = false;
  /** Echo `mark` frames back like Twilio does once the audio queued before the mark has played. */
  echoMarks = false;
  markDelayMs = 0;
  send(data: string) {
    this.sent.push(data);
    const m = JSON.parse(data);
    if (m.event === "mark" && this.echoMarks) setTimeout(() => this.twilio({ event: "mark", streamSid: m.streamSid, mark: { name: m.mark.name } }), this.markDelayMs);
  }
  close() { if (!this.closed) { this.closed = true; this.emit("close"); } }
  twilio(frame: Record<string, unknown>) { this.emit("message", JSON.stringify(frame)); }
  events() { return this.sent.map((m) => JSON.parse(m).event as string); }
}

function fakeTwilio(remote: { status: string; duration?: string } = { status: "completed", duration: "60" }) {
  const forms: Record<string, string>[] = [];
  let hangups = 0; let fetches = 0;
  const http: TwilioHttp = {
    async form(method, path, form) {
      if (method === "POST" && path.endsWith("/Calls.json")) { forms.push(form!); return { status: 201, json: { sid: "CA900", status: "queued" } }; }
      if (method === "POST" && path.endsWith("/Calls/CA900.json")) { hangups++; return { status: 200, json: { sid: "CA900", status: "completed" } }; }
      fetches++;
      return { status: 200, json: { sid: "CA900", ...remote } };
    },
  };
  return { client: new TwilioClient(http), forms, hangups: () => hangups, fetches: () => fetches };
}

interface ProviderOpts {
  remote?: { status: string; duration?: string };
  /** Use the wall clock (the hangup sequence polls real timers). Default: a manually ticked fake clock. */
  realClock?: boolean;
  closeTiming?: Partial<CloseTiming>;
}

function makeProvider(remote?: { status: string; duration?: string }, opts: ProviderOpts = {}) {
  const tw = fakeTwilio(remote ?? opts.remote);
  const ws = new FakeWs();
  const wsCalls: { url: string; headers: Record<string, string> }[] = [];
  let now = 1_000_000;
  const p = new OpenAiLiveProvider({
    twilio: tw.client, wsFactory: (url, headers) => { wsCalls.push({ url, headers }); return ws; },
    now: opts.realClock ? undefined : () => now,
    // No Twilio mark echo unless a test opts in (the default FakeMediaWs never answers marks).
    closeTiming: { playoutWaitMs: 0, ...(opts.closeTiming ?? {}) },
  });
  return { p, ws, wsCalls, tw, tick: (ms: number) => { now += ms; } };
}

/** Fast hangup-sequence timings for the closing tests (poll interval = quiet / 4 = 15 ms). */
const FAST_CLOSE: CloseTiming = { goodbyeStartWaitMs: 150, goodbyeQuietMs: 60, goodbyeMaxMs: 1500, outcomeWaitMs: 80, delegationWaitMs: 300, playoutWaitMs: 200, maxCancels: 2 };

const input = () => ({
  task_id: "task_l1", envelope: buildEnvelope({ recipient_name: "Riverside Dental", phone_number: "+16145550100", objective: "Book cleaning", required_outputs: ["appointment date"] }),
  recipient_name: "Riverside Dental", phone_number: "+16145550100", max_duration_seconds: 300, idempotency_key: "i1",
});

const sentTypes = (ws: FakeWs) => ws.sent.map((m) => JSON.parse(m).type as string);
const session = (p: OpenAiLiveProvider) => (p as unknown as { calls: Map<string, { session: OpenAiLiveSession }> }).calls.get("CA900")!.session;

/** Dial, answer, open the media stream + OpenAI socket, and get the session to `started`. */
async function answeredCall(opts: ProviderOpts = {}) {
  const ctx = makeProvider(opts.remote, opts);
  await ctx.p.startCall(input());
  const media = new FakeMediaWs();
  ctx.p.attachMediaStream(media);
  media.twilio({ event: "connected", protocol: "Call" });
  media.twilio({ event: "start", start: { streamSid: "MZ1", callSid: "CA900", customParameters: { task_id: "task_l1" }, mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 } } });
  ctx.ws.emit("open");
  return { ...ctx, media };
}

/**
 * A call in the middle of a conversation, on the wall clock with FAST_CLOSE timings: session started, the callee has
 * spoken, the agent has answered once. Twilio echoes marks. Returns helpers that emit GPT-Live server events.
 */
async function midConversation(closeTiming: Partial<CloseTiming> = {}) {
  const ctx = await answeredCall({ realClock: true, closeTiming: { ...FAST_CLOSE, ...closeTiming } });
  ctx.media.echoMarks = true;
  const sess = session(ctx.p);
  await sess.handle(JSON.stringify({ type: "session.started", session: { id: "live_close" } }));
  const human = (text: string, startMs = 1000) => sess.handle(JSON.stringify({ type: "session.input_transcript.delta", delta: text, start_ms: startMs, end_ms: startMs + 500 }));
  const agentSays = (text: string, startMs = 2000) => sess.handle(JSON.stringify({ type: "session.output_transcript.delta", delta: text, start_ms: startMs, end_ms: startMs + 500 }));
  const agentAudio = () => sess.handle(JSON.stringify({ type: "session.output_audio.delta", delta: "QUJD" }));
  /** Agent speaks for `ms`: first audio frame, the transcript text right behind it, then audio every 10 ms until `ms`. */
  const agentTurn = async (text: string, ms = 80, startMs = 5000) => { const t0 = Date.now(); await agentAudio(); await agentSays(text, startMs); while (Date.now() - t0 < ms) { await sleep(10); await agentAudio(); } };
  const calleeAudio = (payload = "AAAA") => ctx.media.twilio({ event: "media", media: { track: "inbound", payload } });
  const delegation = (id: string) => sess.handle(JSON.stringify({ type: "session.delegation.created", delegation: { id, type: "delegation", target: "responses" }, response_id: `resp_${id}` }));
  const tool = (delegationId: string, callId: string, name: string, args: Record<string, unknown>) => sess.handle(JSON.stringify({ type: "response.event", delegation_id: delegationId, event: { type: "response.output_item.done", item: { type: "function_call", status: "completed", call_id: callId, name, arguments: JSON.stringify(args) } } }));
  const outcomeArgs = { status: "success", summary: "Booked Tuesday 10.", human_or_business_reached: "receptionist", results: { "appointment date": "Tuesday" }, commitments_made: [], financial_commitments: [], dates_and_times: ["Tuesday 10:00"], confirmation_numbers: [], follow_up_required: false, follow_up: null, questions_for_brian: [] };
  await human("Riverside Dental, this is Maria.", 800);
  await agentTurn("Hi, this is Brian's AI assistant. I'd like to book a cleaning.", 40, 2500);
  await human("Sure, Tuesday at 10 works.", 6000);
  await sleep(FAST_CLOSE.goodbyeQuietMs + 20); // the agent's last audio is stale: a trigger now is not "mid-goodbye"
  /** Wait until the call has ended (or `ms` elapsed). */
  const untilEnded = async (ms = 1500) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if ((await ctx.p.getOutcome("CA900")).ended) return true; await sleep(10); } return false; };
  const sentTypesNow = () => sentTypes(ctx.ws);
  return { ...ctx, sess, human, agentSays, agentAudio, agentTurn, calleeAudio, delegation, tool, outcomeArgs, untilEnded, sentTypesNow };
}

test("openai_live provider name is accepted by config", () => {
  assert.equal(assertProvider("openai_live"), "openai_live");
  assert.throws(() => assertProvider("openai-live"));
});

test("Twilio dial form: single callee leg with Media Streams TwiML, async AMD, status callbacks on openai-live paths", () => {
  const twiml = mediaStreamTwiml({ publicBaseUrl: "https://example.test", taskId: "task_abc" });
  assert.match(twiml, /<Connect><Stream url="wss:\/\/example\.test\/webhooks\/openai-live\/media"><Parameter name="task_id" value="task_abc"\/><\/Stream><\/Connect>/);
  const form = dialForm({ to: "+16145550100", from: "+16145550000", taskId: "task_abc", maxDurationSeconds: 300, publicBaseUrl: "https://example.test", ringTimeoutSeconds: 40 });
  assert.equal(form.To, "+16145550100");
  assert.equal(form.From, "+16145550000");
  assert.equal(form.StatusCallback, "https://example.test/webhooks/openai-live/twilio/status");
  assert.equal(form.AsyncAmdStatusCallback, "https://example.test/webhooks/openai-live/twilio/amd");
  assert.equal(form.MachineDetection, "Enable");
  assert.equal(form.AsyncAmd, "true");
  assert.equal(form.TimeLimit, "300");
  assert.equal(form.Timeout, "40");
});

test("openai_live end-to-end (faked): dial -> media stream -> session.start -> audio relay -> delegated tools -> hangup -> result", async () => {
  const { p, ws, wsCalls, tw, media } = await answeredCall();
  assert.equal(tw.forms[0].To, "+16145550100");
  assert.match(tw.forms[0].Twiml, /openai-live\/media/);
  assert.ok(!JSON.stringify(tw.forms[0]).includes("sk-test-key"), "no OpenAI key sent to Twilio");

  // OpenAI socket: URL, auth header, session.start shape
  assert.equal(wsCalls[0].url, "wss://api.openai.com/v1/live/sessions");
  assert.equal(wsCalls[0].headers.Authorization, "Bearer sk-test-key");
  assert.ok(wsCalls[0].headers["User-Agent"]);
  const start = JSON.parse(ws.sent[0]);
  assert.equal(start.type, "session.start");
  assert.equal(start.session.model, "gpt-live-1");
  assert.deepEqual(start.session.audio, { format: { type: "audio/pcmu", rate: 8000 }, output: { voice: "willow" } }, "default voice is willow");
  assert.match(start.session.instructions, /Riverside Dental/);
  assert.match(start.session.instructions, /Purpose of this call: Book cleaning/);
  assert.match(start.session.instructions, /Say nothing until the person who answered has spoken/);
  assert.equal(start.session.delegation.type, "responses");
  assert.equal(start.session.delegation.responses.model, "gpt-5.6-terra");
  assert.match(start.session.delegation.responses.instructions, /report_outcome/);
  assert.deepEqual(start.session.delegation.responses.tools.map((t: { name: string }) => t.name), [...LIVE_TOOL_NAMES]);
  assert.ok(!start.session.delegation.responses.tools.some((t: { name: string }) => t.name === "send_dtmf"), "no DTMF tool on a media-stream bridge");
  assert.ok(!JSON.stringify(start).includes("sk-test-key"), "api key never in session payload");
  assert.equal(ws.sent.length, 1, "nothing else before session.started");

  // Twilio media before session.started is dropped (docs: wait for session.started before sending audio)
  media.twilio({ event: "media", media: { track: "inbound", payload: "AAAA", chunk: "1", timestamp: "0" } });
  assert.equal(ws.sent.length, 1);
  assert.equal((await p.getOutcome("CA900")).state, "in_progress", "stream start marks the callee as answered");

  const sess = session(p);
  await sess.handle(JSON.stringify({ type: "session.started", session: { id: "live_abc" } }));
  media.twilio({ event: "media", media: { track: "inbound", payload: "BBBB", chunk: "2", timestamp: "20" } });
  const append = JSON.parse(ws.sent[1]);
  assert.deepEqual(append, { type: "session.input_audio.append", audio: "BBBB" }, "mu-law forwarded as is");

  // Silent on pickup: no greeting nudge inside the wait window
  await sleep(20);
  assert.ok(!sentTypes(ws).includes("session.commentary.append"), "agent stays silent until the human speaks");

  // Human greets -> GPT-Live answers on its own; audio flows back to Twilio
  await sess.handle(JSON.stringify({ type: "session.input_transcript.delta", delta: "Riverside Dental, ", start_ms: 800, end_ms: 1400 }));
  await sess.handle(JSON.stringify({ type: "session.input_transcript.delta", delta: "this is Maria.", start_ms: 1400, end_ms: 2000 }));
  await sleep(80);
  assert.ok(!sentTypes(ws).includes("session.commentary.append"), "no fallback greeting once the human spoke");
  await sess.handle(JSON.stringify({ type: "session.output_audio.delta", delta: "Q0ND" }));
  const toTwilio = media.sent.map((m) => JSON.parse(m));
  assert.deepEqual(toTwilio[0], { event: "media", streamSid: "MZ1", media: { payload: "Q0ND" } });
  await sess.handle(JSON.stringify({ type: "session.output_transcript.delta", delta: "Hi, this is Brian's AI assistant. ", start_ms: 2500, end_ms: 4000 }));
  await sess.handle(JSON.stringify({ type: "session.output_transcript.delta", delta: "I'd like to book a cleaning.", start_ms: 4000, end_ms: 5000 }));
  await sess.handle(JSON.stringify({ type: "session.input_transcript.delta", delta: "Sure, Tuesday at 10.", start_ms: 6000, end_ms: 7000 }));

  // Backend (Responses delegation) records the outcome, then ends the call
  await sess.handle(JSON.stringify({ type: "session.delegation.created", delegation: { id: "item_d1", type: "delegation", target: "responses" }, response_id: "resp_1" }));
  const outcome = { status: "success", summary: "Booked Tuesday 10.", human_or_business_reached: "receptionist", results: { "appointment date": "Tuesday" }, commitments_made: [], financial_commitments: [], dates_and_times: ["Tuesday 10:00"], confirmation_numbers: [], follow_up_required: false, follow_up: null, questions_for_brian: [] };
  await sess.handle(JSON.stringify({ type: "response.event", delegation_id: "item_d1", event: { type: "response.output_item.done", item: { type: "function_call", status: "completed", call_id: "call_1", name: "report_outcome", arguments: JSON.stringify(outcome) } } }));
  const msgs = ws.sent.map((m) => JSON.parse(m));
  const fco = msgs.find((m) => m.type === "response.item.create");
  assert.equal(fco.item.type, "function_call_output");
  assert.equal(fco.item.call_id, "call_1");
  assert.equal(JSON.parse(fco.item.output).recorded, true);
  assert.ok(msgs.some((m) => m.type === "response.create"), "backend response is continued after the tool result");
  // duplicate delivery of the same call_id is ignored
  await sess.handle(JSON.stringify({ type: "response.event", delegation_id: "item_d1", event: { type: "response.output_item.done", item: { type: "function_call", status: "completed", call_id: "call_1", name: "report_outcome", arguments: "{}" } } }));
  assert.equal(ws.sent.filter((m) => JSON.parse(m).type === "response.item.create").length, 1);
  await sess.handle(JSON.stringify({ type: "response.event", delegation_id: "item_d1", event: { type: "response.completed", response: { id: "resp_1", output: [] } } }));

  await sess.handle(JSON.stringify({ type: "response.event", delegation_id: "item_d2", event: { type: "response.output_item.done", item: { type: "function_call", status: "completed", call_id: "call_2", name: "end_call", arguments: JSON.stringify({ reason: "objective_complete" }) } } }));
  assert.equal(tw.hangups(), 1, "end_call hangs up via Twilio");
  assert.ok(sentTypes(ws).includes("session.close"), "session.close sent on end_call");
  let out = await p.getOutcome("CA900");
  assert.equal(out.ended, true, "end_call finalizes without waiting for a Twilio callback");
  assert.equal(out.state, "completed");
  assert.equal(out.raw.end_reason, "objective_complete");
  assert.equal(out.raw.openai_session_id, "live_abc");

  // Graceful close ack + late Twilio callback; Twilio's CallDuration wins
  await sess.handle(JSON.stringify({ type: "session.closed", reason: "close_requested", usage: { seconds: 48 } }));
  assert.ok(ws.closed, "socket released after session.closed");
  p.handleTwilioStatus({ CallSid: "CA900", CallStatus: "completed", CallDuration: "56" });
  out = await p.getOutcome("CA900");
  assert.equal(out.duration_seconds, 56);
  assert.equal(out.human_answered, true);
  assert.equal(out.voicemail, false);
  assert.equal(out.provider_extraction?.status, "success");
  assert.equal(out.cost_usd, 0.04, "voice layer at $0.05/min from session usage");
  assert.equal(out.raw.live_close_reason, "close_requested");
  assert.match(out.transcript, /^human: Riverside Dental, this is Maria\./, "fragments grouped into a human turn, first in order");
  assert.match(out.transcript, /assistant: Hi, this is Brian's AI assistant\. I'd like to book a cleaning\./);
  assert.match(out.transcript, /human: Sure, Tuesday at 10\./);
  const latency = out.raw.latency as { first_human_transcript_ms: number; first_agent_audio_ms: number; turn_latencies_ms: number[]; delegation_roundtrips_ms: number[] };
  assert.equal(typeof latency.first_human_transcript_ms, "number");
  assert.equal(typeof latency.first_agent_audio_ms, "number");
  assert.equal(latency.turn_latencies_ms.length, 1, "one human->agent turn gap measured");
  assert.equal(latency.delegation_roundtrips_ms.length, 1);
});

test("two layers: live prompt is short and conversation-only; backend prompt carries the full envelope, authority and tools", async () => {
  const { p, ws } = await answeredCall();
  const s = JSON.parse(ws.sent[0]).session;
  const live: string = s.instructions;
  const backend: string = s.delegation.responses.instructions;
  // live: OpenAI's live-prompting template sections, Brian's phone prefs, and the conversational facts it needs
  for (const re of [/^You are calling Riverside Dental on behalf of Brian\. Speak warmly and naturally, short sentences, unhurried but not slow\./, /busy or frustrated, acknowledge briefly/, /Purpose of this call: Book cleaning/,
    /Backchannel policy: Use moderate backchannels\. Acknowledge naturally without competing with the main response\./, /Interruption policy: Stop speaking when the user interrupts\. Listen to what they say\./,
    /Delegation policy:\nBackend tools:\n- Call outcome reporting and ending the call/, /Delegate to the backend when:\n- You need to record the final outcome or hang up/, /A correction changes work already requested/, /Do not delegate to the backend when:\n- Greetings, small talk, or repeating a still-current result/,
    /Delegate before giving an answer that depends on backend work\.\nDo not guess the result while waiting\.\nDo not promise a booking, price, or completed action before the backend confirms\./,
    /Opening: Say nothing until the person who answered has spoken\. Then open in one short sentence .* and pause/]) assert.match(live, re);
  assert.ok(live.length < 2500, `live prompt should stay small (got ${live.length} chars)`);
  // live: no tool names, schemas, envelope sections, required outputs, preferences or authority tables
  for (const re of [/report_outcome/, /ask_owner/, /end_call/, /note_hold/, /\nAUTHORITY\n/, /\nTOOLS\n/, /REQUIRED OUTPUTS/, /appointment date/, /PREFERENCES/, /You may agree to/, /json/i]) assert.doesNotMatch(live, re);
  // backend: everything heavy
  for (const re of [/\nOBJECTIVE\n/, /\nREQUIRED OUTPUTS/, /- appointment date/, /\nAUTHORITY\n/, /Authorize spending: NO amount is pre-approved/, /\nTOOLS\n/, /report_outcome/, /ask_owner/, /end_call/, /note_hold/, /VOICE CONVERSATION CONTEXT/, /Fact, preference or choice question/, /Never repeat report_outcome or end_call/]) assert.match(backend, re);
  assert.doesNotMatch(backend, /send_dtmf/, "backend is told it has no DTMF, not to use send_dtmf");
  assert.match(backend, /cannot press phone-menu digits/);
  // tool schemas live in delegation.responses.tools, not in any prompt
  assert.ok(s.delegation.responses.tools.find((t: { name: string }) => t.name === "report_outcome").parameters.properties.confirmation_numbers);
  void p;
});

test("opening_instruction reaches the live prompt; authority, context and preferences reach only the backend", async () => {
  const { p, ws } = makeProvider();
  const env = buildEnvelope({ recipient_name: "Clinic", phone_number: "+16145550100", objective: "Cancel Brian's Friday visit", required_outputs: [], authority: { may_cancel: true, may_authorize_amount_up_to: 50, may_disclose: ["date of birth"] }, relevant_context: { dob: "1980-01-02" }, preferences: { time_of_day: "mornings" } });
  await p.startCall({ ...input(), envelope: env, recipient_name: "Clinic", opening_instruction: "Ask for the front desk." });
  const media = new FakeMediaWs();
  p.attachMediaStream(media);
  media.twilio({ event: "start", start: { streamSid: "MZ1", callSid: "CA900", customParameters: { task_id: "task_l1" } } });
  ws.emit("open");
  const s = JSON.parse(ws.sent[0]).session;
  const live: string = s.instructions;
  const backend: string = s.delegation.responses.instructions;
  assert.match(live, /You are calling Clinic on behalf of Brian/);
  assert.match(live, /Purpose of this call: Cancel Brian's Friday visit/);
  assert.match(live, /Opening guidance: Ask for the front desk\./);
  for (const re of [/1980-01-02/, /mornings/, /date of birth/, /\$50/]) assert.doesNotMatch(live, re);
  for (const re of [/- dob: 1980-01-02/, /- time_of_day: mornings/, /Cancel an appointment or service: YES/, /Authorize spending: up to \$50 total/, /You may disclose only these personal details if asked: date of birth/]) assert.match(backend, re);
});

test("stale backend results after the call ends are recorded but not fed back to the live model", async () => {
  const { p, ws, tw } = await answeredCall();
  const sess = session(p);
  await sess.handle(JSON.stringify({ type: "session.started", session: { id: "live_stale" } }));
  // Brian is being asked; meanwhile the callee hangs up and Twilio reports completed.
  const pending = sess.handle(JSON.stringify({ type: "response.event", delegation_id: "item_q", event: { type: "response.output_item.done", item: { type: "function_call", status: "completed", call_id: "q9", name: "ask_owner", arguments: JSON.stringify({ question: "Tue or Wed?" }) } } }));
  await sleep(5);
  assert.equal((await p.getOutcome("CA900")).state, "needs_user");
  p.handleTwilioStatus({ CallSid: "CA900", CallStatus: "completed", CallDuration: "12" });
  await pending; // the hold is released with no answer when the call ends
  const after = ws.sent.map((m) => JSON.parse(m).type);
  assert.ok(after.includes("session.close"));
  assert.ok(!after.includes("response.item.create"), "no tool output sent into a closing session");
  assert.ok(!after.includes("response.create"));
  const out = await p.getOutcome("CA900");
  assert.equal(out.state, "completed");
  assert.deepEqual(out.raw.stale_results, ["ask_owner"]);
  assert.match(out.transcript, /\[owner did not answer in time\]/);
  assert.equal(tw.hangups(), 0, "call already over; nothing to hang up");
  // a late end_call from the backend is harmless too
  await sess.handle(JSON.stringify({ type: "response.event", delegation_id: "item_e", event: { type: "response.output_item.done", item: { type: "function_call", status: "completed", call_id: "e9", name: "end_call", arguments: JSON.stringify({ reason: "other" }) } } }));
  assert.equal(tw.hangups(), 0, "no hangup request for a call that already ended");
  assert.equal((await p.getOutcome("CA900")).duration_seconds, 12, "already-ended call keeps its Twilio duration");
  assert.equal((await p.getOutcome("CA900")).raw.end_reason, "other", "late end_call still records its reason");
});

test("greeting hold: silent pickup opens after OPENAI_LIVE_GREETING_WAIT_MS via instructions.append + commentary.append, once", async () => {
  const { p, ws } = await answeredCall();
  const sess = session(p);
  await sess.handle(JSON.stringify({ type: "session.started", session: { id: "live_1" } }));
  await sleep(25);
  assert.ok(!sentTypes(ws).includes("session.instructions.append"), "still waiting for hello");
  await sleep(70);
  const types = sentTypes(ws);
  assert.equal(types.filter((t) => t === "session.instructions.append").length, 1);
  assert.equal(types.filter((t) => t === "session.commentary.append").length, 1);
  const instr = ws.sent.map((m) => JSON.parse(m)).find((m) => m.type === "session.instructions.append");
  assert.equal(instr.delegation_id, null);
  assert.match(instr.content, /Brian's AI assistant/);
  assert.equal((await p.getOutcome("CA900")).raw.greeting_fallback, true);
  // a later human hello must not re-trigger anything
  await sess.handle(JSON.stringify({ type: "session.input_transcript.delta", delta: "Hello?", start_ms: 3000, end_ms: 3400 }));
  await sleep(70);
  assert.equal(sentTypes(ws).filter((t) => t === "session.commentary.append").length, 1);
});

test("greeting wait is not armed before session.started; human speech before the timer cancels it", async () => {
  const { p, ws } = await answeredCall();
  await sleep(80);
  assert.ok(!sentTypes(ws).includes("session.commentary.append"), "no timer before session.started");
  const sess = session(p);
  await sess.handle(JSON.stringify({ type: "session.started", session: { id: "live_2" } }));
  await sess.handle(JSON.stringify({ type: "session.input_transcript.delta", delta: "Hi", start_ms: 0, end_ms: 200 }));
  await sleep(90);
  assert.ok(!sentTypes(ws).includes("session.commentary.append"));
  assert.notEqual((await p.getOutcome("CA900")).raw.greeting_fallback, true);
});

test("barge-in: Twilio clear drops the queued agent audio on a substantive interruption (default on), not on a backchannel; off with OPENAI_LIVE_CLEAR_ON_BARGE_IN=false", async () => {
  assert.equal(config.openaiLive.clearOnBargeIn, true, "default is on");
  const { p, media } = await answeredCall();
  const sess = session(p);
  await sess.handle(JSON.stringify({ type: "session.started", session: { id: "live_3" } }));
  await sess.handle(JSON.stringify({ type: "session.output_audio.delta", delta: "AAAA" }));
  await sess.handle(JSON.stringify({ type: "session.input_transcript.delta", delta: "Mm-hmm,", start_ms: 0, end_ms: 100 }));
  assert.deepEqual(media.events(), ["media"], "a backchannel is not an interruption");
  await sess.handle(JSON.stringify({ type: "session.input_transcript.delta", delta: " wait, which day?", start_ms: 100, end_ms: 600 }));
  assert.deepEqual(media.events(), ["media", "clear"], "real content while the agent is talking: stop the tail");
  await sess.handle(JSON.stringify({ type: "session.input_transcript.delta", delta: " I mean Tuesday.", start_ms: 600, end_ms: 900 }));
  assert.deepEqual(media.events(), ["media", "clear"], "one clear per stretch of agent speech");

  const saved = config.openaiLive.clearOnBargeIn;
  try {
    (config.openaiLive as { clearOnBargeIn: boolean }).clearOnBargeIn = false;
    const off = await answeredCall();
    const s2 = session(off.p);
    await s2.handle(JSON.stringify({ type: "session.started", session: { id: "live_4" } }));
    await s2.handle(JSON.stringify({ type: "session.output_audio.delta", delta: "AAAA" }));
    await s2.handle(JSON.stringify({ type: "session.input_transcript.delta", delta: "Wait", start_ms: 0, end_ms: 100 }));
    assert.deepEqual(off.media.events(), ["media"], "off: GPT-Live handles the interruption itself");
  } finally { (config.openaiLive as { clearOnBargeIn: boolean }).clearOnBargeIn = saved; }
});

test("media stream for an unknown CallSid is refused; a second stream for the same call is refused", async () => {
  const { p } = makeProvider();
  await p.startCall(input());
  const stranger = new FakeMediaWs();
  p.attachMediaStream(stranger);
  stranger.twilio({ event: "start", start: { streamSid: "MZx", callSid: "CA_NOT_OURS", customParameters: {} } });
  assert.equal(stranger.closed, true);
  const first = new FakeMediaWs();
  p.attachMediaStream(first);
  first.twilio({ event: "start", start: { streamSid: "MZ1", callSid: "CA900", customParameters: { task_id: "task_l1" } } });
  assert.equal(first.closed, false);
  const dup = new FakeMediaWs();
  p.attachMediaStream(dup);
  dup.twilio({ event: "start", start: { streamSid: "MZ2", callSid: "CA900", customParameters: { task_id: "task_l1" } } });
  assert.equal(dup.closed, true);
});

test("openai_live needs_user: ask_owner holds, answer is delivered; timeout returns NO_ANSWER", async () => {
  const { p, ws } = await answeredCall();
  const sess = session(p);
  await sess.handle(JSON.stringify({ type: "session.started", session: { id: "live_5" } }));
  const pending = sess.handle(JSON.stringify({ type: "response.event", delegation_id: "item_q", event: { type: "response.output_item.done", item: { type: "function_call", status: "completed", call_id: "q1", name: "ask_owner", arguments: JSON.stringify({ question: "Tue or Wed?", options: ["Tue", "Wed"] }) } } }));
  await sleep(5);
  const st = await p.getOutcome("CA900");
  assert.equal(st.state, "needs_user");
  const pq = st.raw.pending_question as { id: string; question: string; options: string[] };
  assert.equal(pq.question, "Tue or Wed?");
  assert.deepEqual(pq.options, ["Tue", "Wed"]);
  assert.equal((await p.answerQuestion("CA900", "stale", "Tue")).delivered, false);
  assert.equal((await p.answerQuestion("CA900", pq.id, "Tue")).delivered, true);
  await pending;
  const out = ws.sent.map((m) => JSON.parse(m)).find((m) => m.type === "response.item.create");
  assert.equal(JSON.parse(out.item.output).answer, "Tue");
  assert.equal((await p.getOutcome("CA900")).state, "in_progress");
  assert.match((await p.getOutcome("CA900")).transcript, /\[owner answered: Tue\]/);

  // timeout path
  const t = await answeredCall();
  const sess2 = session(t.p);
  await sess2.handle(JSON.stringify({ type: "session.started", session: { id: "live_6" } }));
  await sess2.handle(JSON.stringify({ type: "response.event", delegation_id: "item_q2", event: { type: "response.output_item.done", item: { type: "function_call", status: "completed", call_id: "q2", name: "ask_owner", arguments: JSON.stringify({ question: "?" }) } } }));
  const out2 = t.ws.sent.map((m) => JSON.parse(m)).find((m) => m.type === "response.item.create");
  assert.equal(JSON.parse(out2.item.output).answer, "NO_ANSWER");
});

test("voicemail (async AMD) appends a voicemail instruction and maps to voicemail; busy / no-answer / failed / never-answered map to failed", async () => {
  const { p, ws } = await answeredCall();
  const sess = session(p);
  await sess.handle(JSON.stringify({ type: "session.started", session: { id: "live_7" } }));
  p.handleTwilioAmd({ CallSid: "CA900", AnsweredBy: "machine_end_beep" });
  const instr = ws.sent.map((m) => JSON.parse(m)).find((m) => m.type === "session.instructions.append");
  assert.match(instr.content, /voicemail/i);
  p.handleTwilioStatus({ CallSid: "CA900", CallStatus: "completed", CallDuration: "20" });
  const out = await p.getOutcome("CA900");
  assert.equal(out.voicemail, true); assert.equal(out.human_answered, false); assert.equal(out.duration_seconds, 20); assert.equal(out.state, "completed");

  for (const [status, err] of [["busy", "busy"], ["no-answer", "no_answer"], ["failed", "failed"]] as const) {
    const q = makeProvider();
    await q.p.startCall(input());
    q.p.handleTwilioStatus({ CallSid: "CA900", CallStatus: "ringing" });
    assert.equal((await q.p.getOutcome("CA900")).state, "ringing");
    q.p.handleTwilioStatus({ CallSid: "CA900", CallStatus: status });
    const o = await q.p.getOutcome("CA900");
    assert.equal(o.state, "failed"); assert.equal(o.error, err);
  }
  const r = makeProvider();
  await r.p.startCall(input());
  r.p.handleTwilioStatus({ CallSid: "CA900", CallStatus: "completed", CallDuration: "0" });
  const ro = await r.p.getOutcome("CA900");
  assert.equal(ro.state, "failed"); assert.equal(ro.error, "no_answer");
});

test("stream stop / session close reconcile against Twilio; quiet callbacks reconcile; cancel hangs up", async () => {
  // Twilio says completed after the media stream stops -> finalized
  const a = await answeredCall({ remote: { status: "completed", duration: "33" } });
  a.media.twilio({ event: "stop" });
  await sleep(5);
  const ao = await a.p.getOutcome("CA900");
  assert.equal(ao.ended, true); assert.equal(ao.state, "completed"); assert.equal(ao.duration_seconds, 33); assert.equal(a.tw.fetches(), 1);
  assert.ok(sentTypes(a.ws).includes("session.close") || a.ws.closed, "OpenAI session is closed when the stream stops");

  // OpenAI drops the session while Twilio is still in-progress -> we hang up the callee leg instead of leaving dead air
  const b = await answeredCall({ remote: { status: "in-progress" } });
  await session(b.p).handle(JSON.stringify({ type: "session.started", session: { id: "live_drop" } }));
  b.ws.close();
  await sleep(5);
  const bo = await b.p.getOutcome("CA900");
  assert.equal(bo.ended, true); assert.equal(bo.state, "failed"); assert.match(String(bo.error), /^live_session_closed:/);
  assert.equal(b.tw.hangups(), 1, "Twilio leg hung up after the session dropped");
  assert.equal(b.media.closed, true);

  // ... but a session we closed ourselves (stream stopped) still just reconciles
  const b2 = await answeredCall({ remote: { status: "in-progress" } });
  b2.media.twilio({ event: "stop" });
  await sleep(5);
  assert.equal((await b2.p.getOutcome("CA900")).ended, false);
  assert.equal(b2.tw.hangups(), 0);

  // quiet callbacks -> reconcile after TWILIO_RECONCILE_AFTER_MS
  const c = makeProvider({ status: "completed", duration: "60" });
  await c.p.startCall(input());
  c.p.handleTwilioStatus({ CallSid: "CA900", CallStatus: "in-progress" });
  c.tick(1_000);
  assert.equal((await c.p.getOutcome("CA900")).ended, false);
  assert.equal(c.tw.fetches(), 0);
  c.tick(60_000);
  const co = await c.p.getOutcome("CA900");
  assert.equal(co.ended, true); assert.equal(co.state, "completed"); assert.equal(c.tw.fetches(), 1);

  const d = makeProvider();
  await d.p.startCall(input());
  const r = await d.p.cancelCall("CA900");
  assert.equal(r.cancelled, true); assert.equal(d.tw.hangups(), 1);
  assert.equal((await d.p.getOutcome("CA900")).state, "cancelled");
});

test("preflight lists missing env and startCall refuses without it", async () => {
  const saved = config.openaiLive.apiKey;
  try {
    (config.openaiLive as { apiKey: string }).apiKey = "";
    assert.deepEqual(OpenAiLiveProvider.preflight(), ["OPENAI_API_KEY"]);
    const { p } = makeProvider();
    await assert.rejects(() => p.startCall(input()), /missing OPENAI_API_KEY/);
  } finally { (config.openaiLive as { apiKey: string }).apiKey = saved; }
  assert.deepEqual(OpenAiLiveProvider.preflight(), []);
});

test("session config honors env-backed backend tuning and per-call voice", async () => {
  const saved = { ...config.openaiLive };
  try {
    Object.assign(config.openaiLive, { backendModel: "gpt-5.6-luna", backendReasoningEffort: "low", backendServiceTier: "priority", store: true });
    const { p, ws } = makeProvider();
    await p.startCall({ ...input(), preferred_voice: "gleam" });
    const media = new FakeMediaWs();
    p.attachMediaStream(media);
    media.twilio({ event: "start", start: { streamSid: "MZ1", callSid: "CA900", customParameters: { task_id: "task_l1" } } });
    ws.emit("open");
    const s = JSON.parse(ws.sent[0]).session;
    assert.equal(s.audio.output.voice, "gleam");
    assert.equal(s.delegation.responses.model, "gpt-5.6-luna");
    assert.deepEqual(s.delegation.responses.reasoning, { effort: "low" });
    assert.equal(s.delegation.responses.service_tier, "priority");
    assert.equal(s.store, true);
  } finally { Object.assign(config.openaiLive, saved); }
});

test("HTTP layer: signed Twilio callbacks route to openai_live; Media Streams WebSocket upgrades on /webhooks/openai-live/media only", async () => {
  const { p, ws } = makeProvider();
  await p.startCall(input());
  const store = new CallStore(mkdtempSync(join(tmpdir(), "phone-live-http-")));
  const service = new PhoneService({ providers: { openai_live: p }, defaultProvider: "openai_live", store, useLlmExtraction: false });
  const server = createHttpServer(service, { openaiLive: p });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  const signed = (path: string, form: Record<string, string>) => {
    const data = `${config.publicBaseUrl}${path}` + Object.keys(form).sort().map((k) => k + form[k]).join("");
    return createHmac("sha1", config.twilio.authToken).update(data).digest("base64");
  };
  try {
    const health = await (await fetch(`${base}/healthz`)).json() as { providers: string[] };
    assert.deepEqual(health.providers, ["openai_live"]);

    const form = { CallSid: "CA900", CallStatus: "ringing" };
    const bad = await fetch(`${base}/webhooks/openai-live/twilio/status`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": "nope" }, body: new URLSearchParams(form).toString() });
    assert.equal(bad.status, 401);
    const ok = await fetch(`${base}/webhooks/openai-live/twilio/status`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": signed("/webhooks/openai-live/twilio/status", form) }, body: new URLSearchParams(form).toString() });
    assert.equal(ok.status, 200);
    assert.equal((await p.getOutcome("CA900")).state, "ringing");
    const amd = { CallSid: "CA900", AnsweredBy: "human" };
    await fetch(`${base}/webhooks/openai-live/twilio/amd`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": signed("/webhooks/openai-live/twilio/amd", amd) }, body: new URLSearchParams(amd).toString() });
    assert.equal((await p.getOutcome("CA900")).raw.answered_by, "human");
    // xai-only webhooks report not configured rather than crashing
    assert.equal((await fetch(`${base}/webhooks/xai`, { method: "POST", body: "{}" })).status, 503);

    // wrong WS path is refused
    await assert.rejects(new Promise((_, reject) => { const w = new WebSocket(`ws://127.0.0.1:${port}/nope`); w.on("error", reject); w.on("open", () => reject(new Error("should not open"))); }));

    // real Twilio-style stream
    const client = new WebSocket(`ws://127.0.0.1:${port}/webhooks/openai-live/media`);
    await new Promise<void>((r, j) => { client.on("open", () => r()); client.on("error", j); });
    client.send(JSON.stringify({ event: "connected", protocol: "Call" }));
    client.send(JSON.stringify({ event: "start", start: { streamSid: "MZ9", callSid: "CA900", customParameters: { task_id: "task_l1" } } }));
    await sleep(30);
    assert.equal((await p.getOutcome("CA900")).state, "in_progress");
    assert.equal((await p.getOutcome("CA900")).raw.stream_sid, "MZ9");
    ws.emit("open");
    await session(p).handle(JSON.stringify({ type: "session.started", session: { id: "live_http" } }));
    const gotMedia = new Promise<Record<string, unknown>>((r) => client.on("message", (d) => r(JSON.parse(String(d)))));
    client.send(JSON.stringify({ event: "media", media: { track: "inbound", payload: "ZZZZ" } }));
    await session(p).handle(JSON.stringify({ type: "session.output_audio.delta", delta: "YYYY" }));
    assert.deepEqual(await gotMedia, { event: "media", streamSid: "MZ9", media: { payload: "YYYY" } });
    await sleep(10);
    assert.ok(ws.sent.some((m) => m === JSON.stringify({ type: "session.input_audio.append", audio: "ZZZZ" })), "inbound audio reached the GPT-Live socket");
    client.close();
  } finally {
    service.shutdown();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("openai_live through PhoneService with per-call provider override; bland remains default", async () => {
  const { p } = makeProvider();
  const store = new CallStore(mkdtempSync(join(tmpdir(), "phone-live-")));
  const stub = { name: "bland" as const, startCall: async () => { throw new Error("bland should not be called"); }, getOutcome: async () => { throw new Error("x"); }, cancelCall: async () => ({ cancelled: false }) };
  const s = new PhoneService({ providers: { bland: stub, openai_live: p }, defaultProvider: "bland", store, useLlmExtraction: false, pollIntervalMs: 10_000 });
  const started = await s.makeCall({ recipient_name: "R", phone_number: "+16145550100", objective: "Book", required_outputs: ["appointment date"], provider: "openai_live" });
  assert.equal(started.provider, "openai_live");
  assert.equal(started.call_id, "CA900");
  p.handleTwilioStatus({ CallSid: "CA900", CallStatus: "in-progress" });
  assert.equal((await s.getStatus({ task_id: started.task_id })).state, "in_progress");
  p.handleTwilioStatus({ CallSid: "CA900", CallStatus: "completed", CallDuration: "30" });
  const result = (await s.getResult({ task_id: started.task_id })) as NormalizedResult;
  assert.equal(result.provider, "openai_live");
  assert.ok(["partial", "failed"].includes(result.status)); // no transcript, no tool outcome -> not success
  s.shutdown();
});

// ---------------------------------------------------------------------------------------------------------------
// Hangup on farewell (Sep 15 2026 trial: goodbye did not end the call; the agent kept taking farewell turns)
// ---------------------------------------------------------------------------------------------------------------

test("farewell helpers: closing lines, false positives, callee utterance classes", () => {
  for (const s of ["Goodbye!", "Thanks Maria, you're all set for Tuesday at 10. Goodbye.", "Have a great day.", "Take care, bye now.", "Bye-bye!", "Talk to you soon.", "Alright, see you Tuesday.", "Thank you so much, have a good one!"]) assert.equal(isClosingLine(s), true, s);
  for (const s of ["Before we say goodbye, which day works best?", "Is Tuesday a good day for that?", "We'll take care of it for you.", "I see you have an appointment on file.", "I'd like to buy a plan.", "Anything else before we say goodbye?", "Goodbye is such a hard word. What time was it again?", ""]) assert.equal(isClosingLine(s), false, s);
  assert.equal(containsFarewell("Before we say goodbye, which day works?"), true, "containsFarewell is the loose check; isClosingLine looks at the last sentence");
  assert.equal(containsFarewell("we take care of billing"), false);
  for (const s of ["Bye!", "okay bye", "Thanks, you too, bye bye.", "Have a good day", "alright take care", "Thank you so much, goodbye.", "Sure, Tuesday at 10 works. Alright, thanks, bye!"]) assert.equal(classifyHumanUtterance(s), "farewell", s);
  for (const s of ["okay", "Yeah.", "mm-hmm", "Thanks so much!", "Sounds good.", "perfect, thank you", ""]) assert.equal(classifyHumanUtterance(s), "ack", s);
  for (const s of ["Wait", "Hold on, what time was that?", "Actually one more thing", "bye, wait, which Tuesday?", "No, that's wrong", "Okay bye oh wait actually can you also ask about parking", "Bye. Actually, hold on."]) assert.equal(classifyHumanUtterance(s), "substantive", s);
  assert.equal(isClosingLine("Goodbye, Maria!"), true, "a name after the goodbye is fine");
  assert.equal(isClosingLine("Goodbye, and let me know if anything changes with the schedule"), false, "a goodbye followed by more content is not the close");
});

test("agent goodbye ends the call without any end_call: one farewell, callee audio muted, Twilio mark confirms playout, then hangup", async () => {
  const c = await midConversation();
  assert.equal(c.tw.hangups(), 0);
  // The live model closes on its own and never delegates (the trial failure mode).
  await c.agentTurn("Great, you're all set for Tuesday at 10. Thanks Maria, goodbye!", 80, 8000);
  const lastGoodbyeAudio = Date.now();
  assert.equal(c.sess.closingStage, "goodbye", "the farewell sentence starts the close while the audio is still playing");
  assert.equal(c.tw.hangups(), 0, "not hung up mid-sentence");
  while (Date.now() - lastGoodbyeAudio < 1000 && c.tw.hangups() === 0) await sleep(5);
  const tail = Date.now() - lastGoodbyeAudio;
  assert.equal(c.tw.hangups(), 1);
  assert.ok(tail >= FAST_CLOSE.goodbyeQuietMs - 5 && tail < FAST_CLOSE.goodbyeQuietMs + 150, `hangup ~quiet + mark echo after the last goodbye frame (${tail} ms)`);
  assert.equal(await c.untilEnded(), true, "record finalized after the (empty) outcome window");
  const out = await c.p.getOutcome("CA900");
  assert.equal(out.state, "completed");
  assert.equal(out.raw.close_trigger, "agent_farewell");
  assert.equal(out.raw.end_reason, "agent_said_goodbye");
  assert.equal(typeof out.raw.goodbye_done_ms, "number");
  const events = c.media.events();
  assert.ok(events.includes("mark"), "playout mark sent to Twilio before hanging up");
  assert.ok(events.lastIndexOf("mark") > events.lastIndexOf("media"), "mark queued after the last goodbye audio frame");
  assert.ok(c.sentTypesNow().includes("session.close"));
  assert.equal(c.sess.inputMuted, true);
  // Nothing after the goodbye can reach the model: the callee's "bye" is not forwarded, so no second farewell turn.
  const appends = c.sentTypesNow().filter((t) => t === "session.input_audio.append").length;
  c.calleeAudio("BBBB");
  assert.equal(c.sentTypesNow().filter((t) => t === "session.input_audio.append").length, appends);
  assert.match(out.transcript, /assistant: Great, you're all set for Tuesday at 10\. Thanks Maria, goodbye!/);
});

test("agent goodbye with the outcome still being recorded: hangs up promptly anyway, then collects report_outcome from the lingering session", async () => {
  const c = await midConversation();
  await c.delegation("item_d1");
  const goodbyeDone = Date.now() + 60;
  await c.agentTurn("Perfect, Tuesday at 10 it is. Goodbye!", 60, 8000);
  // Phone tail: hangup lands ~quiet + mark echo after the last goodbye frame, not after the backend.
  const t0 = Date.now();
  while (Date.now() - t0 < 1000 && c.tw.hangups() === 0) await sleep(5);
  const tail = Date.now() - goodbyeDone;
  assert.equal(c.tw.hangups(), 1, "Twilio hung up without waiting for the delegation");
  assert.ok(tail < FAST_CLOSE.goodbyeQuietMs + 150, `tail after the goodbye stayed short (${tail} ms)`);
  assert.ok(c.media.events().includes("mark"));
  assert.equal(c.media.closed, true, "media socket closed with the hangup (ends the <Connect><Stream> call immediately)");
  let out = await c.p.getOutcome("CA900");
  assert.equal(out.ended, false, "record not final yet: collecting the outcome from the open session");
  assert.equal(typeof out.raw.hangup_at, "string");
  assert.ok(!c.sentTypesNow().includes("session.close"), "OpenAI session kept open for the backend result");
  // Twilio's completed callback and the stream stop arrive right after our hangup; neither finalizes early.
  c.p.handleTwilioStatus({ CallSid: "CA900", CallStatus: "completed", CallDuration: "41" });
  c.media.twilio({ event: "stop" });
  await sleep(20);
  assert.equal((await c.p.getOutcome("CA900")).ended, false);
  assert.ok(!c.sentTypesNow().includes("session.close"));
  const before = c.sentTypesNow().filter((t) => t === "response.create").length;
  await c.tool("item_d1", "call_ro", "report_outcome", c.outcomeArgs);
  assert.equal(c.sentTypesNow().filter((t) => t === "response.create").length, before, "backend response is not continued once the goodbye has played (no second goodbye)");
  assert.equal(await c.untilEnded(), true);
  out = await c.p.getOutcome("CA900");
  assert.equal(out.state, "completed");
  assert.equal(out.provider_extraction?.status, "success", "outcome landed after the hangup and is in the result");
  assert.deepEqual(out.raw.stale_results, undefined, "collected result is not stale");
  assert.equal(out.duration_seconds, 41, "Twilio duration from the callback that arrived during collection");
  assert.ok(c.sentTypesNow().includes("session.close"), "session closed once the outcome was in");
  assert.equal(c.tw.hangups(), 1);
  // late end_call from the same backend turn is harmless and only refines the reason
  await c.tool("item_d1", "call_ec", "end_call", { reason: "objective_complete" });
  assert.equal(c.tw.hangups(), 1);
  assert.equal((await c.p.getOutcome("CA900")).raw.end_reason, "objective_complete");

  // Backend never answers: the record is finalized after the (longer, delegation-in-flight) collect window, outcome null.
  const d = await midConversation();
  await d.delegation("item_dz");
  await d.agentTurn("All set. Goodbye!", 40, 8000);
  const t1 = Date.now();
  assert.equal(await d.untilEnded(1500), true);
  const took = Date.now() - t1;
  assert.ok(took >= FAST_CLOSE.delegationWaitMs - 20, `waited the delegation window after hangup (${took} ms)`);
  const dout = await d.p.getOutcome("CA900");
  assert.equal(dout.provider_extraction, null);
  assert.equal(dout.state, "completed");
  assert.equal(typeof dout.raw.collect_ms, "number");
});

test("end_call before the goodbye is spoken: backend response is continued, goodbye audio is allowed to start and finish, then hangup", async () => {
  const c = await midConversation();
  await c.delegation("item_d1");
  await c.tool("item_d1", "call_ro", "report_outcome", c.outcomeArgs);
  const pending = c.tool("item_d1", "call_ec", "end_call", { reason: "objective_complete" });
  await sleep(20);
  const types = c.sentTypesNow();
  assert.equal(types.filter((t) => t === "response.item.create").length, 2);
  assert.equal(types.filter((t) => t === "response.create").length, 2, "end_call output is followed by response.create so the live model gets its goodbye line");
  assert.equal(c.tw.hangups(), 0, "not hung up before the goodbye");
  assert.equal(c.sess.closingStage, "goodbye");
  // goodbye starts inside the start window and runs for a while; hangup must wait for it
  await sleep(60);
  await c.agentTurn("You're all set, thanks Maria. Goodbye!", 120, 9000);
  assert.equal(c.tw.hangups(), 0, "still not hung up while the goodbye audio is flowing");
  await pending;
  const out = await c.p.getOutcome("CA900");
  assert.equal(out.ended, true); assert.equal(out.state, "completed"); assert.equal(c.tw.hangups(), 1);
  assert.equal(out.raw.close_trigger, "end_call"); assert.equal(out.raw.end_reason, "objective_complete");
  assert.ok((out.raw.goodbye_done_ms as number) >= 120, `goodbye stage lasted the whole utterance (got ${out.raw.goodbye_done_ms} ms)`);
  assert.ok(c.media.events().includes("mark"));
});

test("end_call with no goodbye at all hangs up after the start window (no dead line)", async () => {
  const c = await midConversation();
  const t0 = Date.now();
  await c.tool("item_dx", "call_ec", "end_call", { reason: "wrong_number" });
  const out = await c.p.getOutcome("CA900");
  assert.equal(out.ended, true); assert.equal(c.tw.hangups(), 1);
  const took = Date.now() - t0;
  assert.ok(took >= FAST_CLOSE.goodbyeStartWaitMs - 5 && took < FAST_CLOSE.goodbyeStartWaitMs + 400, `waited for a goodbye to start, then gave up (${took} ms)`);
  assert.equal(out.raw.end_reason, "wrong_number");
});

test("barge-in during the goodbye cancels the close; a farewell or an acknowledgement does not; the next goodbye ends the call", async () => {
  const c = await midConversation();
  // First goodbye: callee cuts in with a real question while the audio is still playing.
  const first = c.agentTurn("Alright, you're all set. Goodbye!", 120, 8000);
  await sleep(50);
  assert.equal(c.sess.closingStage, "goodbye");
  await c.human("Wait, which Tuesday was that?", 8300);
  assert.equal(c.sess.closingStage, "none", "close cancelled: the person has more to say");
  await first;
  await sleep(FAST_CLOSE.goodbyeStartWaitMs + 100);
  assert.equal(c.tw.hangups(), 0, "no hangup after a cancelled close");
  assert.equal((await c.p.getOutcome("CA900")).raw.close_cancels, 1);
  // Conversation recovers; second goodbye with an acknowledgement + farewell from the callee talking over it.
  await c.agentTurn("Tuesday the 22nd at 10.", 60, 9000);
  await c.human("Oh right, perfect.", 9800);
  const second = c.agentTurn("Anything else is easy to change later. Goodbye!", 120, 10500);
  await sleep(50);
  assert.equal(c.sess.closingStage, "goodbye");
  await c.human("Okay, thanks, bye!", 10800);
  assert.equal(c.sess.closingStage, "goodbye", "a farewell over the goodbye does not cancel");
  await second;
  assert.equal(await c.untilEnded(), true);
  assert.equal(c.tw.hangups(), 1);
  assert.equal((await c.p.getOutcome("CA900")).raw.close_trigger, "agent_farewell");
});

test("cancel budget: after maxCancels barge-ins the close is firm", async () => {
  const c = await midConversation({ maxCancels: 1 });
  const first = c.agentTurn("Okay then, goodbye!", 120, 8000);
  await sleep(50);
  await c.human("Hang on a second", 8200);
  assert.equal(c.sess.closingStage, "none");
  await first;
  await sleep(FAST_CLOSE.goodbyeStartWaitMs + 60);
  assert.equal(c.tw.hangups(), 0);
  const second = c.agentTurn("Sure. All set now, goodbye!", 120, 9500);
  await sleep(50);
  await c.human("Wait wait one more question", 9700);
  assert.equal(c.sess.closingStage, "goodbye", "budget spent: this goodbye is final");
  await second;
  assert.equal(await c.untilEnded(), true);
  assert.equal(c.tw.hangups(), 1);
});

test("a goodbye mentioned inside a question is not a close (early match is abandoned once the sentence finishes)", async () => {
  const c = await midConversation();
  await c.agentTurn("Before we say goodbye, which day works best for you?", 80, 8000);
  await sleep(FAST_CLOSE.goodbyeQuietMs + 80);
  assert.equal(c.sess.closingStage, "none", "close abandoned: the last sentence is a question");
  await sleep(FAST_CLOSE.outcomeWaitMs + FAST_CLOSE.playoutWaitMs + 60);
  assert.equal(c.tw.hangups(), 0);
  assert.equal((await c.p.getOutcome("CA900")).ended, false);
  assert.equal(c.sess.inputMuted, false);
});

test("callee says goodbye and the agent stays silent: hang up after OPENAI_LIVE_FAREWELL_SILENCE_MS instead of a dead line", async () => {
  const c = await midConversation();
  const t0 = Date.now();
  await c.human("Alright, thanks, bye!", 7000);
  assert.equal(c.tw.hangups(), 0);
  assert.equal(await c.untilEnded(1200), true);
  const took = Date.now() - t0;
  assert.ok(took >= config.openaiLive.farewellSilenceMs - 5, `waited for the agent first (${took} ms)`);
  const out = await c.p.getOutcome("CA900");
  assert.equal(out.raw.close_trigger, "human_farewell"); assert.equal(out.raw.end_reason, "callee_said_goodbye"); assert.equal(c.tw.hangups(), 1);
});

test("callee goodbye while the backend is working: watchdog allows one round trip more; agent speaking at the deadline is allowed to finish", async () => {
  const c = await midConversation();
  await c.delegation("item_slow");
  const t0 = Date.now();
  await c.human("Okay, thanks, bye!", 7000);
  await sleep(config.openaiLive.farewellSilenceMs + 40);
  assert.equal(c.tw.hangups(), 0, "delegation in flight: not yet");
  assert.equal(await c.untilEnded(1200), true);
  const took = Date.now() - t0;
  assert.ok(took >= config.openaiLive.farewellSilenceMs * 2 - 10, `doubled window (${took} ms)`);
  assert.equal((await c.p.getOutcome("CA900")).raw.close_trigger, "human_farewell");

  // Agent starts a (non-farewell) sentence just as the silence deadline hits: the close lets that audio finish.
  const d = await midConversation();
  await d.human("Alright, bye now.", 7000);
  await sleep(config.openaiLive.farewellSilenceMs - 30);
  const speaking = d.agentTurn("One last thing, your confirmation code is 4471.", 150, 9000);
  await sleep(80);
  assert.equal(d.tw.hangups(), 0, "not cut mid-sentence");
  await speaking;
  assert.equal(await d.untilEnded(), true);
  assert.equal(d.tw.hangups(), 1);
  assert.ok((await d.p.getOutcome("CA900")).transcript.includes("confirmation code is 4471"));
});

test("callee goodbye answered by the agent's goodbye takes the agent-farewell path once; callee continuing cancels the silence watchdog", async () => {
  const c = await midConversation();
  await c.human("Great, thank you, goodbye!", 7000);
  await sleep(30);
  await c.agentTurn("Thank you, Maria. Goodbye!", 60, 7600);
  assert.equal(await c.untilEnded(), true);
  assert.equal(c.tw.hangups(), 1);
  assert.equal((await c.p.getOutcome("CA900")).raw.close_trigger, "agent_farewell");

  const d = await midConversation();
  await d.human("Okay bye", 7000);
  await sleep(40);
  await d.human("oh wait, actually, can you also ask about parking?", 7500);
  await sleep(config.openaiLive.farewellSilenceMs + 150);
  assert.equal(d.tw.hangups(), 0, "the person kept talking; no silence hangup");
  assert.equal((await d.p.getOutcome("CA900")).ended, false);
});

test("voicemail greeting ending in 'have a great day' does not trip the callee-goodbye watchdog; the agent's own sign-off after the message does", async () => {
  // Fresh pickup: the agent has not spoken yet when the recording signs off.
  const ctx = await answeredCall({ realClock: true, closeTiming: FAST_CLOSE });
  ctx.media.echoMarks = true;
  const sess = session(ctx.p);
  await sess.handle(JSON.stringify({ type: "session.started", session: { id: "live_vm" } }));
  await sess.handle(JSON.stringify({ type: "session.input_transcript.delta", delta: "Hi, you've reached Maria. Leave a message and have a great day!", start_ms: 500, end_ms: 4000 }));
  ctx.p.handleTwilioAmd({ CallSid: "CA900", AnsweredBy: "machine_end_beep" });
  await sleep(config.openaiLive.farewellSilenceMs + 150);
  assert.equal(ctx.tw.hangups(), 0, "no hangup: nobody has been spoken to yet");
  assert.equal((await ctx.p.getOutcome("CA900")).ended, false);
  // Agent leaves the message and signs off -> agent_farewell close, hangup.
  for (let i = 0; i < 4; i++) { await sess.handle(JSON.stringify({ type: "session.output_audio.delta", delta: "QUJD" })); await sleep(10); }
  await sess.handle(JSON.stringify({ type: "session.output_transcript.delta", delta: "Hi Maria, this is Brian's AI assistant calling about a cleaning. Please call us back. Goodbye!", start_ms: 6000, end_ms: 12000 }));
  const t0 = Date.now();
  while (Date.now() - t0 < 1500 && !(await ctx.p.getOutcome("CA900")).ended) await sleep(10);
  const out = await ctx.p.getOutcome("CA900");
  assert.equal(out.ended, true); assert.equal(out.voicemail, true); assert.equal(out.raw.close_trigger, "agent_farewell"); assert.equal(ctx.tw.hangups(), 1);

  // Even after the agent has spoken, a machine's sign-off never triggers the silence hangup.
  const d = await midConversation();
  d.p.handleTwilioAmd({ CallSid: "CA900", AnsweredBy: "machine_start" });
  await d.human("Please leave a message after the tone. Goodbye.", 7000);
  await sleep(config.openaiLive.farewellSilenceMs + FAST_CLOSE.playoutWaitMs + 150);
  assert.equal(d.tw.hangups(), 0);
});

test("Twilio never echoes the mark: hangup still happens after playoutWaitMs", async () => {
  const c = await midConversation();
  c.media.echoMarks = false;
  const t0 = Date.now();
  await c.agentTurn("All set. Goodbye!", 40, 8000);
  assert.equal(await c.untilEnded(1500), true);
  const took = Date.now() - t0;
  assert.ok(took >= FAST_CLOSE.playoutWaitMs, `waited out the mark (${took} ms)`);
  assert.equal(c.tw.hangups(), 1);
});

test("OPENAI_LIVE_FAREWELL_HANGUP=false: goodbyes are ignored, only end_call hangs up", async () => {
  const saved = config.openaiLive.farewellHangup;
  try {
    (config.openaiLive as { farewellHangup: boolean }).farewellHangup = false;
    const c = await midConversation();
    await c.agentTurn("You're all set. Goodbye!", 40, 8000);
    await c.human("Bye!", 8600);
    await sleep(config.openaiLive.farewellSilenceMs + FAST_CLOSE.playoutWaitMs + 150);
    assert.equal(c.tw.hangups(), 0);
    assert.equal(c.sess.closingStage, "none");
    await c.tool("item_dx", "call_ec", "end_call", { reason: "objective_complete" });
    assert.equal(c.tw.hangups(), 1);
  } finally { (config.openaiLive as { farewellHangup: boolean }).farewellHangup = saved; }
});

test("closing does not disturb needs_user: a hold released by Brian's answer still continues the call; a goodbye afterwards ends it", async () => {
  const c = await midConversation();
  const pending = c.tool("item_q", "q1", "ask_owner", { question: "Tue or Wed?", options: ["Tue", "Wed"] });
  await sleep(5);
  const st = await c.p.getOutcome("CA900");
  assert.equal(st.state, "needs_user");
  assert.equal((await c.p.answerQuestion("CA900", (st.raw.pending_question as { id: string }).id, "Tue")).delivered, true);
  await pending;
  assert.equal((await c.p.getOutcome("CA900")).state, "in_progress");
  await c.agentTurn("Brian says Tuesday. You're all set, goodbye!", 40, 9000);
  assert.equal(await c.untilEnded(), true);
  assert.equal((await c.p.getOutcome("CA900")).state, "completed");
});

test("prompts: live Closing rule + backend one-turn close (report_outcome, end_call, goodbye line) replace the goodbye-first ping-pong", async () => {
  const { ws } = await answeredCall();
  const s = JSON.parse(ws.sent[0]).session;
  const live: string = s.instructions;
  assert.match(live, /Closing: .*delegate to the backend first .*then say exactly one short goodbye and stop; the call is hung up for you after it\./);
  assert.match(live, /Never repeat a goodbye, ask "anything else\?", or open a new topic after it\./);
  assert.match(live, /If the person says goodbye first, reply with one short goodbye\./);
  assert.match(live, /If they interrupt your goodbye, answer briefly, then close again\./);
  assert.match(live, /You need to record the final outcome or hang up \(before your goodbye, not after\)/);
  const backend: string = s.delegation.responses.instructions;
  assert.match(backend, /in ONE turn call report_outcome .* then call end_call .* then reply with the single short goodbye sentence/);
  assert.match(backend, /Never tell the assistant to say goodbye and come back to you/);
  const endCall = s.delegation.responses.tools.find((t: { name: string }) => t.name === "end_call");
  assert.match(endCall.description, /Call this right after report_outcome, in the same turn/);
  assert.doesNotMatch(endCall.description, /Only after the assistant has said goodbye/);
});
