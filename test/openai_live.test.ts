import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenAiLiveProvider, dialForm, mediaStreamTwiml, type MediaWsLike } from "../src/providers/openai_live/index.js";
import { OpenAiLiveSession, LIVE_TOOL_NAMES } from "../src/providers/openai_live/live.js";
import { TwilioClient, type TwilioHttp } from "../src/providers/xai/twilio.js";
import { FakeWs } from "../src/providers/xai/fakews.js";
import { buildEnvelope } from "../src/envelope.js";
import { assertProvider, config } from "../src/config.js";
import { PhoneService } from "../src/service.js";
import { CallStore } from "../src/store.js";
import type { NormalizedResult } from "../src/types.js";

// Configure openai_live for tests (no network is ever hit; Twilio, the OpenAI socket and the Twilio media socket are faked).
Object.assign(config.openaiLive, { apiKey: "sk-test-key", greetingWaitMs: 60, hangupDelayMs: 0, clearOnBargeIn: false, store: false });
Object.assign(config.twilio, { accountSid: "ACtest", authToken: "tok", fromNumber: "+16145550000" });
(config as { publicBaseUrl: string }).publicBaseUrl = "https://example.test";
(config as { needsUserHoldSeconds: number }).needsUserHoldSeconds = 0.05;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Server-side Twilio Media Streams socket stand-in: records what we send to Twilio, lets tests inject Twilio frames. */
class FakeMediaWs extends EventEmitter implements MediaWsLike {
  sent: string[] = [];
  closed = false;
  send(data: string) { this.sent.push(data); }
  close() { if (!this.closed) { this.closed = true; this.emit("close"); } }
  twilio(frame: Record<string, unknown>) { this.emit("message", JSON.stringify(frame)); }
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

function makeProvider(remote?: { status: string; duration?: string }) {
  const tw = fakeTwilio(remote);
  const ws = new FakeWs();
  const wsCalls: { url: string; headers: Record<string, string> }[] = [];
  let now = 1_000_000;
  const p = new OpenAiLiveProvider({ twilio: tw.client, wsFactory: (url, headers) => { wsCalls.push({ url, headers }); return ws; }, now: () => now });
  return { p, ws, wsCalls, tw, tick: (ms: number) => { now += ms; } };
}

const input = () => ({
  task_id: "task_l1", envelope: buildEnvelope({ recipient_name: "Riverside Dental", phone_number: "+16145550100", objective: "Book cleaning", required_outputs: ["appointment date"] }),
  recipient_name: "Riverside Dental", phone_number: "+16145550100", max_duration_seconds: 300, idempotency_key: "i1",
});

const sentTypes = (ws: FakeWs) => ws.sent.map((m) => JSON.parse(m).type as string);
const session = (p: OpenAiLiveProvider) => (p as unknown as { calls: Map<string, { session: OpenAiLiveSession }> }).calls.get("CA900")!.session;

/** Dial, answer, open the media stream + OpenAI socket, and get the session to `started`. */
async function answeredCall(opts: { remote?: { status: string; duration?: string } } = {}) {
  const ctx = makeProvider(opts.remote);
  await ctx.p.startCall(input());
  const media = new FakeMediaWs();
  ctx.p.attachMediaStream(media);
  media.twilio({ event: "connected", protocol: "Call" });
  media.twilio({ event: "start", start: { streamSid: "MZ1", callSid: "CA900", customParameters: { task_id: "task_l1" }, mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 } } });
  ctx.ws.emit("open");
  return { ...ctx, media };
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
  assert.deepEqual(start.session.audio, { format: { type: "audio/pcmu", rate: 8000 }, output: { voice: "marin" } });
  assert.match(start.session.instructions, /Riverside Dental/);
  assert.match(start.session.instructions, /Book cleaning/);
  assert.match(start.session.instructions, /Delegation policy/);
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

test("barge-in: Twilio clear is sent only when OPENAI_LIVE_CLEAR_ON_BARGE_IN is on", async () => {
  const saved = config.openaiLive.clearOnBargeIn;
  try {
    (config.openaiLive as { clearOnBargeIn: boolean }).clearOnBargeIn = true;
    const { p, media } = await answeredCall();
    const sess = session(p);
    await sess.handle(JSON.stringify({ type: "session.started", session: { id: "live_3" } }));
    await sess.handle(JSON.stringify({ type: "session.output_audio.delta", delta: "AAAA" }));
    await sess.handle(JSON.stringify({ type: "session.input_transcript.delta", delta: "Wait", start_ms: 0, end_ms: 100 }));
    const events = media.sent.map((m) => JSON.parse(m).event);
    assert.deepEqual(events, ["media", "clear"]);
  } finally { (config.openaiLive as { clearOnBargeIn: boolean }).clearOnBargeIn = saved; }
  const { p, media } = await answeredCall();
  const sess = session(p);
  await sess.handle(JSON.stringify({ type: "session.started", session: { id: "live_4" } }));
  await sess.handle(JSON.stringify({ type: "session.output_audio.delta", delta: "AAAA" }));
  await sess.handle(JSON.stringify({ type: "session.input_transcript.delta", delta: "Wait", start_ms: 0, end_ms: 100 }));
  assert.deepEqual(media.sent.map((m) => JSON.parse(m).event), ["media"], "default: GPT-Live handles the interruption itself");
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

  // Twilio still in-progress when the OpenAI socket drops -> stays open
  const b = await answeredCall({ remote: { status: "in-progress" } });
  b.ws.close();
  await sleep(5);
  assert.equal((await b.p.getOutcome("CA900")).ended, false);

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
