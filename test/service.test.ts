import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockProvider, SCENARIOS, type ScenarioName } from "../src/providers/mock.js";
import { PhoneService } from "../src/service.js";
import { CallStore } from "../src/store.js";
import type { MakeCallRequest, NormalizedResult } from "../src/types.js";

const baseReq = (): MakeCallRequest => ({
  recipient_name: "Test Business", phone_number: "+16145550001",
  objective: "Schedule a cleaning", relevant_context: { patient: "Brian" }, preferences: { time: "mornings" },
  required_outputs: ["appointment date", "appointment time", "confirmation number"], provider: "mock",
});

function svc(scenario: ScenarioName, ticks = 0) {
  const store = new CallStore(mkdtempSync(join(tmpdir(), "phone-test-")));
  const mock = new MockProvider({ scenario, ticks });
  const s = new PhoneService({ providers: { mock }, defaultProvider: "mock", store, useLlmExtraction: false, pollIntervalMs: 20 });
  return { s, store, mock };
}

async function run(scenario: ScenarioName, req = baseReq()) {
  const { s } = svc(scenario);
  const started = await s.makeCall(req);
  const result = (await s.getResult({ task_id: started.task_id })) as NormalizedResult;
  s.shutdown();
  return { started, result };
}

// The 10 regression scenarios from the brief, mocked.
test("1 basic info request -> success with results", async () => {
  const { started, result } = await run("info_request");
  assert.equal(started.status, "queued");
  assert.equal(result.status, "success");
  assert.equal(result.results.price, "$79.99");
  assert.equal(result.provider, "mock");
  assert.ok(result.transcript.includes("$79.99"));
});
test("2 scheduling -> confirmation number and time captured", async () => {
  const { result } = await run("scheduling");
  assert.equal(result.status, "success");
  assert.deepEqual(result.confirmation_numbers, ["DC-48213"]);
  assert.equal(result.results["confirmation number"], "DC-48213");
});
test("3 unexpected harmless question (are you a robot) -> still success, identity disclosed", async () => {
  const { result } = await run("harmless_question");
  assert.equal(result.status, "success");
  assert.match(result.transcript, /AI assistant/);
});
test("4 needs user choice -> needs_user with questions_for_brian and callback follow-up", async () => {
  const { result } = await run("needs_user");
  assert.equal(result.status, "needs_user");
  assert.equal(result.questions_for_brian.length, 1);
  assert.equal(result.follow_up_required, true);
  assert.equal(result.follow_up?.contact, "614-555-0100");
  assert.deepEqual(result.confirmation_numbers, ["FI-2291"]);
});
test("4b needs user with live hold: status exposes pending question, answer completes call", async () => {
  const { s } = svc("needs_user", 2);
  const started = await s.makeCall(baseReq());
  let st = await s.getStatus({ task_id: started.task_id });
  assert.equal(st.state, "in_progress");
  st = await s.getStatus({ task_id: started.task_id });
  assert.equal(st.state, "needs_user");
  assert.equal(st.intervention_required, true);
  assert.ok(st.pending_question?.question);
  const r = await s.answerQuestion({ task_id: started.task_id }, st.pending_question!.id, "Friday 4 PM");
  assert.equal(r.delivered, true);
  const result = (await s.getResult({ task_id: started.task_id })) as NormalizedResult;
  assert.equal(result.status, "success");
  assert.match(result.transcript, /owner answered: Friday 4 PM/);
  s.shutdown();
});
test("5 voicemail -> partial, voicemail flagged, follow-up required", async () => {
  const { started, result } = await run("voicemail");
  assert.equal(result.status, "partial");
  assert.equal(result.human_or_business_reached, "voicemail");
  assert.equal(result.follow_up_required, true);
  const { s } = svc("voicemail");
  const st = await s.getStatus({ task_id: (await s.makeCall(baseReq())).task_id });
  assert.equal(st.voicemail, true);
  assert.ok(started.task_id);
  s.shutdown();
});
test("6 IVR -> navigated and success", async () => {
  const { result } = await run("ivr");
  assert.equal(result.status, "success");
  assert.match(result.transcript, /\[dtmf 1\]/);
});
test("7 prolonged hold -> success, duration recorded", async () => {
  const { result } = await run("hold");
  assert.equal(result.status, "success");
  assert.equal(result.duration_seconds, 480);
});
test("8 repeated interruptions -> success", async () => {
  const { result } = await run("interruptions");
  assert.equal(result.status, "success");
  assert.deepEqual(result.dates_and_times, ["Tuesday 9:00 AM"]);
});
test("9 call drop -> failed with error, transcript preserved for inspection", async () => {
  const { result } = await run("call_drop");
  assert.equal(result.status, "failed");
  assert.equal(result.raw_provider_result.provider, "mock");
  assert.match(result.transcript, /disconnected/);
  assert.equal(result.follow_up_required, true);
});
test("10 cannot complete (outside authority / policy) -> failed with follow-up for Brian", async () => {
  const { result } = await run("cannot_complete");
  assert.equal(result.status, "failed");
  assert.equal(result.follow_up?.by_whom, "brian");
  assert.equal(result.commitments_made.length, 0);
});

// Error handling
test("busy -> failed, error=busy", async () => {
  const { result } = await run("busy");
  assert.equal(result.status, "failed");
  assert.equal(result.raw_provider_result.provider, "mock");
});
test("invalid number rejected before dialing; provider start error recorded", async () => {
  const { s } = svc("invalid_number");
  await assert.rejects(s.makeCall({ ...baseReq(), phone_number: "614-555-0100" }), /E\.164/);
  const started = await s.makeCall(baseReq());
  assert.equal(started.status, "failed");
  const result = (await s.getResult({ task_id: started.task_id })) as NormalizedResult;
  assert.equal(result.status, "failed");
  assert.match(result.summary, /invalid_number/);
  s.shutdown();
});
test("wrong person -> failed, reached=wrong number", async () => {
  const { result } = await run("wrong_person");
  assert.equal(result.status, "failed");
  assert.equal(result.human_or_business_reached, "wrong number");
});
test("cancel active call -> cancelled state", async () => {
  const { s } = svc("hold", 5);
  const started = await s.makeCall(baseReq());
  const r = await s.cancelCall({ task_id: started.task_id });
  assert.equal(r.cancelled, true);
  const st = await s.getStatus({ task_id: started.task_id });
  assert.equal(st.state, "cancelled");
  s.shutdown();
});

// Idempotency + persistence
test("idempotency: same request does not dial twice; explicit key honored", async () => {
  const { s, mock } = svc("info_request");
  const a = await s.makeCall(baseReq());
  const b = await s.makeCall(baseReq());
  assert.equal(b.deduplicated, true);
  assert.equal(a.task_id, b.task_id);
  const c = await s.makeCall({ ...baseReq(), idempotency_key: "k1" });
  const d = await s.makeCall({ ...baseReq(), objective: "different", idempotency_key: "k1" });
  assert.equal(c.task_id, d.task_id);
  assert.ok(mock);
  s.shutdown();
});
test("call records persist to disk with events and no secrets", async () => {
  const { s, store } = svc("scheduling");
  const started = await s.makeCall({ ...baseReq(), relevant_context: { api_key: "sk-should-not-persist", note: "fine" } });
  await s.getResult({ task_id: started.task_id });
  const store2 = new CallStore((store as unknown as { dir: string }).dir);
  const rec = store2.get(started.task_id)!;
  assert.ok(rec.events.some((e) => e.type === "call.initiated"));
  assert.ok(rec.events.some((e) => e.type === "result.extracted"));
  assert.equal((rec.request.relevant_context as Record<string, string>).api_key, "[REDACTED]");
  assert.equal(rec.result?.status, "success");
  s.shutdown();
});
test("lookup by call_id works; unknown id errors", async () => {
  const { s } = svc("info_request");
  const started = await s.makeCall(baseReq());
  const st = await s.getStatus({ call_id: started.call_id! });
  assert.equal(st.task_id, started.task_id);
  await assert.rejects(s.getStatus({ task_id: "task_nope" }), /unknown/);
  s.shutdown();
});
test("all scenarios produce a schema-complete result", async () => {
  for (const name of Object.keys(SCENARIOS) as ScenarioName[]) {
    if (SCENARIOS[name].fail_start) continue;
    const { result } = await run(name);
    for (const k of ["task_id", "status", "summary", "human_or_business_reached", "results", "commitments_made", "financial_commitments", "dates_and_times", "confirmation_numbers", "follow_up_required", "follow_up", "questions_for_brian", "duration_seconds", "transcript", "recording_reference", "provider", "raw_provider_result"]) {
      assert.ok(k in result, `${name} missing ${k}`);
    }
  }
});
