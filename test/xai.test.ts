import { test } from "node:test";
import assert from "node:assert/strict";
import { XaiProvider } from "../src/providers/xai/index.js";
import { TwilioClient, dialCalleeTwiml, xaiSipUri, type TwilioHttp } from "../src/providers/xai/twilio.js";
import { verifyXaiWebhook, signXaiWebhook } from "../src/providers/xai/webhook.js";
import { FakeWs } from "../src/providers/xai/fakews.js";
import { buildEnvelope } from "../src/envelope.js";
import { config } from "../src/config.js";
import { PhoneService } from "../src/service.js";
import { CallStore } from "../src/store.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NormalizedResult } from "../src/types.js";

// Configure xai for tests (no network is ever hit; Twilio + WS are faked).
Object.assign(config.xai, { apiKey: "test-key", sipNumber: "+16145559999", webhookSecret: "whsec_" + Buffer.from("secret").toString("base64") });
Object.assign(config.twilio, { accountSid: "ACtest", authToken: "tok", fromNumber: "+16145550000" });
(config as { publicBaseUrl: string }).publicBaseUrl = "https://example.test";
(config as { needsUserHoldSeconds: number }).needsUserHoldSeconds = 0.05;

function fakeTwilio(remote: { status: string; duration?: string } = { status: "completed", duration: "60" }) {
  const forms: Record<string, string>[] = [];
  let hangups = 0; let fetches = 0;
  const http: TwilioHttp = {
    async form(method, path, form) {
      if (method === "POST" && path.endsWith("/Calls.json")) { forms.push(form!); return { status: 201, json: { sid: "CA123", status: "queued" } }; }
      if (method === "POST" && path.endsWith("/Calls/CA123.json")) { hangups++; return { status: 200, json: { sid: "CA123", status: "completed" } }; }
      fetches++;
      return { status: 200, json: { sid: "CA123", ...remote } };
    },
  };
  return { client: new TwilioClient(http), forms, hangups: () => hangups, fetches: () => fetches };
}

function makeProvider(remote?: { status: string; duration?: string }) {
  const tw = fakeTwilio(remote);
  const ws = new FakeWs();
  let now = 1_000_000;
  const p = new XaiProvider({ twilio: tw.client, wsFactory: () => ws, now: () => now });
  return { p, ws, tw, tick: (ms: number) => { now += ms; } };
}

const input = () => ({
  task_id: "task_x1", envelope: buildEnvelope({ recipient_name: "Riverside Dental", phone_number: "+16145550100", objective: "Book cleaning", required_outputs: ["appointment date"] }),
  recipient_name: "Riverside Dental", phone_number: "+16145550100", max_duration_seconds: 300, idempotency_key: "i1",
});

test("SIP-first topology: Twilio dials xAI SIP (with task header), TwiML dials the human from the live leg with no ringback", () => {
  assert.equal(xaiSipUri("task_abc"), "sip:+16145559999@sip.voice.x.ai;transport=tls?X-Task-Id=task_abc");
  const twiml = dialCalleeTwiml({ to: "+16145550100", from: "+16145550000", maxDurationSeconds: 300, publicBaseUrl: "https://example.test" });
  assert.match(twiml, /<Dial callerId="\+16145550000" timeout="40" timeLimit="300" answerOnBridge="false">/);
  assert.match(twiml, /<Number statusCallback="https:\/\/example\.test\/webhooks\/twilio\/status" statusCallbackEvent="initiated ringing answered completed" statusCallbackMethod="POST" machineDetection="Enable" amdStatusCallback="https:\/\/example\.test\/webhooks\/twilio\/amd" amdStatusCallbackMethod="POST">\+16145550100<\/Number>/);
  assert.ok(!twiml.includes("<Sip>"), "no Dial->Sip on an answered PSTN leg (that is what played ringback to the callee)");
});

test("webhook signature verification (standard-webhooks scheme)", () => {
  const body = JSON.stringify({ type: "realtime.call.incoming", data: { call_id: "xc1" } });
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = signXaiWebhook("msg_1", ts, body, config.xai.webhookSecret);
  assert.equal(verifyXaiWebhook({ "webhook-id": "msg_1", "webhook-timestamp": ts, "webhook-signature": sig }, body, config.xai.webhookSecret).ok, true);
  assert.equal(verifyXaiWebhook({ "webhook-id": "msg_1", "webhook-timestamp": ts, "webhook-signature": "v1,bad" }, body, config.xai.webhookSecret).ok, false);
  assert.equal(verifyXaiWebhook({ "webhook-id": "msg_1", "webhook-timestamp": "1", "webhook-signature": sig }, body, config.xai.webhookSecret).ok, false);
});

test("xai end-to-end (faked): dial -> incoming webhook -> session.update with envelope -> tools -> result", async () => {
  const { p, ws, tw } = makeProvider();
  const s = await p.startCall(input());
  assert.equal(s.call_id, "CA123");
  assert.equal(tw.forms[0].To, xaiSipUri("task_x1"), "parent leg goes to xAI SIP first");
  assert.match(tw.forms[0].Twiml, /<Number[^>]*>\+16145550100<\/Number>/, "human is dialed from the answered SIP leg");
  assert.match(tw.forms[0].StatusCallback, /webhooks\/twilio\/status$/);
  assert.ok(!JSON.stringify(tw.forms[0]).includes("test-key"), "no api key sent to twilio");

  // xAI answers the SIP leg and fires the webhook before the human is even dialed.
  p.handleTwilioStatus({ CallSid: "CA123", CallStatus: "in-progress" });
  const att = p.handleXaiIncoming({ type: "realtime.call.incoming", data: { call_id: "xc1" } });
  assert.deepEqual(att, { attached: true, task_id: "task_x1" });
  ws.emit("open");
  const su = JSON.parse(ws.sent[0]);
  assert.equal(su.type, "session.update");
  assert.equal(su.session.voice, "eve");
  assert.match(su.session.instructions, /Riverside Dental/);
  assert.match(su.session.instructions, /Book cleaning/);
  assert.ok(su.session.tools.some((t: { name: string }) => t.name === "report_outcome"));
  assert.ok(!JSON.stringify(su).includes("test-key"), "api key never in session payload");
  assert.equal(ws.sent.length, 1, "greeting is held until the human answers (no response.create yet)");
  assert.equal((await p.getOutcome("CA123")).state, "dialing");

  // child PSTN leg
  p.handleTwilioStatus({ CallSid: "CA456", ParentCallSid: "CA123", CallStatus: "ringing" });
  assert.equal((await p.getOutcome("CA123")).state, "ringing");
  assert.equal((await p.getOutcome("CA123")).duration_seconds, null, "no talk time before answer");
  p.handleTwilioStatus({ CallSid: "CA456", ParentCallSid: "CA123", CallStatus: "in-progress" });
  assert.equal(JSON.parse(ws.sent[1]).type, "response.create", "greeting released on human answer");
  p.handleTwilioAmd({ CallSid: "CA456", AnsweredBy: "human" });

  const sess = (p as unknown as { calls: Map<string, { session: { handle(s: string): Promise<void> } }> }).calls.get("CA123")!.session;
  await sess.handle(JSON.stringify({ type: "response.output_audio_transcript.done", transcript: "Hi, this is Brian's AI assistant." }));
  await sess.handle(JSON.stringify({ type: "conversation.item.input_audio_transcription.completed", transcript: "Sure, Tuesday at 10." }));
  await sess.handle(JSON.stringify({ type: "response.done", response: { output: [{ type: "function_call", name: "report_outcome", call_id: "c1", arguments: JSON.stringify({ status: "success", summary: "Booked Tuesday 10.", human_or_business_reached: "receptionist", results: { "appointment date": "Tuesday" }, commitments_made: [], financial_commitments: [], dates_and_times: ["Tuesday 10:00"], confirmation_numbers: [], follow_up_required: false, follow_up: null, questions_for_brian: [] }) }] } }));
  const fco = ws.sent.map((m) => JSON.parse(m)).find((m) => m.type === "conversation.item.create");
  assert.equal(fco.item.type, "function_call_output");
  assert.equal(fco.item.call_id, "c1");
  await sess.handle(JSON.stringify({ type: "response.function_call_arguments.done", name: "end_call", call_id: "c2", arguments: JSON.stringify({ reason: "objective_complete" }) }));
  assert.equal(tw.hangups(), 1);
  // No Twilio "completed" callback yet: end_call alone must finalize the call.
  let out = await p.getOutcome("CA123");
  assert.equal(out.ended, true, "objective_complete finalizes without waiting for a callback");
  assert.equal(out.state, "completed");
  assert.equal(out.raw.end_reason, "objective_complete");
  // Late callbacks are harmless and the child leg's CallDuration wins for talk time.
  p.handleTwilioStatus({ CallSid: "CA456", ParentCallSid: "CA123", CallStatus: "completed", CallDuration: "56" });
  p.handleTwilioStatus({ CallSid: "CA123", CallStatus: "completed", CallDuration: "70" });
  out = await p.getOutcome("CA123");
  assert.equal(out.duration_seconds, 56);
  assert.equal(out.human_answered, true);
  assert.equal(out.voicemail, false);
  assert.equal(out.provider_extraction?.status, "success");
  assert.match(out.transcript, /Tuesday at 10/);
  assert.ok(ws.closed);
});

test("xai needs_user: ask_owner holds, answer is delivered; timeout returns NO_ANSWER", async () => {
  const { p, ws } = makeProvider();
  await p.startCall(input());
  p.handleXaiIncoming({ data: { call_id: "xc1", sip_headers: { "X-Task-Id": "task_x1" } } });
  ws.emit("open");
  p.handleTwilioStatus({ CallSid: "CA456", ParentCallSid: "CA123", CallStatus: "in-progress" });
  const sess = (p as unknown as { calls: Map<string, { session: { handle(s: string): Promise<void> } }> }).calls.get("CA123")!.session;
  const pending = sess.handle(JSON.stringify({ type: "response.done", response: { output: [{ type: "function_call", name: "ask_owner", call_id: "q1", arguments: JSON.stringify({ question: "Tue or Wed?", options: ["Tue", "Wed"] }) }] } }));
  await new Promise((r) => setTimeout(r, 5));
  const st = await p.getOutcome("CA123");
  assert.equal(st.state, "needs_user");
  const pq = (st.raw.pending_question as { id: string; question: string });
  assert.equal(pq.question, "Tue or Wed?");
  assert.equal((await p.answerQuestion("CA123", pq.id, "Tue")).delivered, true);
  await pending;
  const out = ws.sent.map((m) => JSON.parse(m)).find((m) => m.type === "conversation.item.create");
  assert.equal(JSON.parse(out.item.output).answer, "Tue");
  assert.equal((await p.getOutcome("CA123")).state, "in_progress");

  // timeout path
  const p2 = makeProvider();
  await p2.p.startCall(input());
  p2.p.handleXaiIncoming({ data: { call_id: "xc2" } });
  p2.ws.emit("open");
  const sess2 = (p2.p as unknown as { calls: Map<string, { session: { handle(s: string): Promise<void> } }> }).calls.get("CA123")!.session;
  await sess2.handle(JSON.stringify({ type: "response.done", response: { output: [{ type: "function_call", name: "ask_owner", call_id: "q2", arguments: JSON.stringify({ question: "?" }) }] } }));
  const out2 = p2.ws.sent.map((m) => JSON.parse(m)).find((m) => m.type === "conversation.item.create");
  assert.equal(JSON.parse(out2.item.output).answer, "NO_ANSWER");
});

test("xai voicemail (AMD machine) and busy / no-answer / drop map to outcomes", async () => {
  const { p } = makeProvider();
  await p.startCall(input());
  p.handleTwilioStatus({ CallSid: "CA456", ParentCallSid: "CA123", CallStatus: "in-progress" });
  p.handleTwilioAmd({ CallSid: "CA456", AnsweredBy: "machine_end_beep" });
  p.handleTwilioStatus({ CallSid: "CA456", ParentCallSid: "CA123", CallStatus: "completed", CallDuration: "20" });
  const out = await p.getOutcome("CA123");
  assert.equal(out.voicemail, true); assert.equal(out.human_answered, false); assert.equal(out.duration_seconds, 20);

  for (const [status, err] of [["busy", "busy"], ["no-answer", "no_answer"], ["failed", "failed"]] as const) {
    const q = makeProvider();
    await q.p.startCall(input());
    q.p.handleTwilioStatus({ CallSid: "CA456", ParentCallSid: "CA123", CallStatus: status });
    const o = await q.p.getOutcome("CA123");
    assert.equal(o.state, "failed"); assert.equal(o.error, err);
  }
  // Parent completed with the human never answered -> failed/no_answer, not "completed".
  const r = makeProvider();
  await r.p.startCall(input());
  r.p.handleTwilioStatus({ CallSid: "CA123", CallStatus: "completed", CallDuration: "45" });
  const ro = await r.p.getOutcome("CA123");
  assert.equal(ro.state, "failed"); assert.equal(ro.error, "no_answer");
});

test("xai reconciles with Twilio when callbacks go quiet, when the socket closes, and after max duration", async () => {
  // quiet callbacks: Twilio says completed -> finalize (this is the stuck-in_progress case)
  const a = makeProvider({ status: "completed", duration: "60" });
  await a.p.startCall(input());
  a.p.handleTwilioStatus({ CallSid: "CA456", ParentCallSid: "CA123", CallStatus: "in-progress" });
  a.tick(1_000);
  assert.equal((await a.p.getOutcome("CA123")).ended, false, "recent callback: no reconcile yet");
  assert.equal(a.tw.fetches(), 0);
  a.tick(60_000);
  const ao = await a.p.getOutcome("CA123");
  assert.equal(ao.ended, true); assert.equal(ao.state, "completed"); assert.equal(a.tw.fetches(), 1);

  // socket closed by xAI while Twilio still says in-progress -> stays open, then finalizes once Twilio reports completed
  const b = makeProvider({ status: "in-progress" });
  await b.p.startCall(input());
  b.p.handleXaiIncoming({ data: { call_id: "xc1" } });
  b.ws.emit("open");
  b.p.handleTwilioStatus({ CallSid: "CA456", ParentCallSid: "CA123", CallStatus: "in-progress" });
  b.ws.close();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal((await b.p.getOutcome("CA123")).ended, false);

  // over max duration with Twilio unreachable -> provider_timeout
  const c = makeProvider();
  (c.tw.client as unknown as { http: TwilioHttp }).http = { async form(method, path) { if (method === "GET") throw new Error("down"); return { status: 500, json: {} }; } };
  await c.p.startCall(input()).catch(() => undefined);
});

test("xai cancel hangs up via Twilio", async () => {
  const { p, tw } = makeProvider();
  await p.startCall(input());
  const r = await p.cancelCall("CA123");
  assert.equal(r.cancelled, true); assert.equal(tw.hangups(), 1);
  assert.equal((await p.getOutcome("CA123")).state, "cancelled");
});

test("xai through PhoneService with per-call provider override; bland remains default", async () => {
  const { p, ws } = makeProvider();
  const store = new CallStore(mkdtempSync(join(tmpdir(), "phone-xai-")));
  const stub = { name: "bland" as const, startCall: async () => { throw new Error("bland should not be called"); }, getOutcome: async () => { throw new Error("x"); }, cancelCall: async () => ({ cancelled: false }) };
  const s = new PhoneService({ providers: { bland: stub, xai: p }, defaultProvider: "bland", store, useLlmExtraction: false, pollIntervalMs: 10_000 });
  const started = await s.makeCall({ recipient_name: "R", phone_number: "+16145550100", objective: "Book", required_outputs: ["appointment date"], provider: "xai" });
  assert.equal(started.provider, "xai");
  p.handleXaiIncoming({ data: { call_id: "xc9" } });
  ws.emit("open");
  p.handleTwilioStatus({ CallSid: "CA456", ParentCallSid: started.call_id!, CallStatus: "in-progress" });
  p.handleTwilioStatus({ CallSid: "CA456", ParentCallSid: started.call_id!, CallStatus: "completed", CallDuration: "30" });
  const result = (await s.getResult({ task_id: started.task_id })) as NormalizedResult;
  assert.equal(result.provider, "xai");
  assert.ok(["partial", "failed"].includes(result.status)); // no transcript, no tool outcome -> not success
  s.shutdown();
});
