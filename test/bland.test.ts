import { test } from "node:test";
import assert from "node:assert/strict";
import { BlandProvider, mapBlandDetails, type BlandHttp } from "../src/providers/bland.js";
import { buildEnvelope } from "../src/envelope.js";

const input = () => ({
  task_id: "task_1", envelope: buildEnvelope({ recipient_name: "Dr. Office", phone_number: "+16145550100", objective: "Book cleaning", required_outputs: ["date"] }),
  recipient_name: "Dr. Office", phone_number: "+16145550100", max_duration_seconds: 600, idempotency_key: "idem1",
});

test("Bland payload matches the documented POST /v1/calls shape", () => {
  const p = new BlandProvider({ request: async () => ({ status: 200, json: {} }) }).buildPayload(input());
  for (const k of ["phone_number", "task", "first_sentence", "voice", "model", "wait_for_greeting", "interruptibility", "background_track", "temperature", "record", "max_duration", "voicemail"]) assert.ok(k in p, `missing ${k}`);
  assert.equal(p.phone_number, "+16145550100");
  assert.equal(p.max_duration, 10);
  assert.deepEqual(p.voicemail, { action: "leave_message" });
  assert.equal(p.wait_for_greeting, true);
  assert.match(p.task, /AI assistant calling for Brian/);
  assert.match(p.task, /Cancel an appointment or service: NO/);
  assert.match(p.first_sentence, /Brian's AI assistant/);
  assert.ok(!/api[_-]?key/i.test(p.task), "no secrets in prompt");
});

test("Bland start/poll/cancel flow with mocked HTTP", async () => {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  let polls = 0;
  const http: BlandHttp = {
    async request(method, path, body) {
      calls.push({ method, path, body });
      if (method === "POST" && path === "/v1/calls") return { status: 200, json: { status: "success", message: "Call successfully queued.", call_id: "b-123" } };
      if (method === "GET") {
        polls++;
        return polls < 2
          ? { status: 200, json: { call_id: "b-123", completed: false, queue_status: "started" } }
          : { status: 200, json: { call_id: "b-123", completed: true, status: "completed", answered_by: "human", call_length: 1.5, price: 0.14, summary: "Booked Tuesday 10am.", recording_url: "https://rec/1", concatenated_transcript: "assistant: hi\nuser: booked, conf 8812", transcripts: [{ user: "assistant", text: "hi" }, { user: "user", text: "booked, conf 8812" }] } };
      }
      if (path.endsWith("/stop")) return { status: 200, json: { status: "success", message: "Call ended successfully." } };
      return { status: 404, json: {} };
    },
  };
  const p = new BlandProvider(http);
  const s = await p.startCall(input());
  assert.equal(s.call_id, "b-123");
  const first = await p.getOutcome("b-123");
  assert.equal(first.ended, false);
  assert.equal(first.state, "in_progress");
  const done = await p.getOutcome("b-123");
  assert.equal(done.ended, true);
  assert.equal(done.human_answered, true);
  assert.equal(done.duration_seconds, 90);
  assert.equal(done.cost_usd, 0.14);
  assert.equal(done.recording_reference, "https://rec/1");
  assert.equal(done.provider_extraction?.summary, "Booked Tuesday 10am.");
  assert.equal(done.transcript_turns[1].speaker, "human");
  const c = await p.cancelCall("b-123");
  assert.equal(c.cancelled, true);
  assert.equal(calls[0].method, "POST");
});

test("Bland mapping: voicemail, no-answer, error", () => {
  assert.equal(mapBlandDetails({ call_id: "x", completed: true, answered_by: "voicemail" }).voicemail, true);
  const na = mapBlandDetails({ call_id: "x", completed: true, answered_by: "no-answer" });
  assert.equal(na.state, "failed"); assert.equal(na.error, "no_answer");
  const err = mapBlandDetails({ call_id: "x", completed: true, error_message: "invalid number" });
  assert.equal(err.state, "failed"); assert.equal(err.error, "invalid number");
});

test("Bland API error surfaces as thrown error (recorded by service as failed)", async () => {
  const p = new BlandProvider({ request: async () => ({ status: 400, json: { status: "error", message: "Invalid phone number" } }) });
  await assert.rejects(p.startCall(input()), /Invalid phone number/);
});
