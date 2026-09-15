/**
 * Dry-run demo. No network, no keys.
 *   npm run demo                  -> mock provider, scheduling scenario, full envelope -> result flow
 *   npm run demo -- needs_user    -> any scenario name from src/providers/mock.ts
 *   npm run demo -- xai-session   -> drives XaiRealtimeSession with a fake socket: envelope -> session.update -> tool calls -> structured outcome
 *   npm run demo -- openai-live-session -> drives OpenAiLiveSession (GPT-Live-1) with a fake socket: session.start -> transcript -> delegated tools -> outcome
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockProvider, SCENARIOS, type ScenarioName } from "../providers/mock.js";
import { PhoneService } from "../service.js";
import { CallStore } from "../store.js";
import { buildEnvelope, buildAgentInstructions, buildLiveInstructions } from "../envelope.js";
import { XaiRealtimeSession, TOOL_NAMES } from "../providers/xai/realtime.js";
import { OpenAiLiveSession, LIVE_TOOL_NAMES, backendInstructionsAddendum } from "../providers/openai_live/live.js";
import { FakeWs } from "../providers/xai/fakews.js";
import { config } from "../config.js";
import type { MakeCallRequest } from "../types.js";

const arg = process.argv[2] ?? "scheduling";
const req: MakeCallRequest = {
  recipient_name: "Riverside Dental", phone_number: "+16145550002",
  objective: "Schedule a routine dental cleaning for Brian in the next two weeks, mornings preferred.",
  relevant_context: { patient_name: "Brian Meilton", existing_patient: true, insurance_on_file: true },
  preferences: { time_of_day: "mornings", avoid: "Fridays" },
  authority: { may_schedule: true, may_reschedule: true },
  required_outputs: ["appointment date", "appointment time", "confirmation number"],
};

if (arg === "xai-session") {
  const env = buildEnvelope(req);
  const instructions = buildAgentInstructions(env, { recipient_name: req.recipient_name, realtime_hold_supported: true, hold_seconds: 45, tools: [...TOOL_NAMES] });
  const ws = new FakeWs();
  const session = new XaiRealtimeSession({ call_id: "demo_call", instructions, voice: "eve", ownerName: "Brian", wsFactory: () => ws,
    hooks: { onAskOwner: async (q) => { console.log(`\n[needs Brian] ${q}\n[auto-answer for demo] Tuesday`); return "Tuesday"; }, onEndCall: async (r) => console.log(`[hangup] reason=${r}`), onSendDtmf: async () => ({ ok: false }) } });
  session.on("turn", (t) => console.log(`${t.speaker}: ${t.text}`));
  session.connect();
  ws.emit("open");
  console.log("--- client -> xAI:", ws.sent.map((m) => JSON.parse(m).type).join(", "));
  console.log("--- session.instructions preview:\n" + JSON.parse(ws.sent[0]).session.instructions.slice(0, 600) + "\n...");
  await session.handle(JSON.stringify({ type: "response.output_audio_transcript.done", transcript: "Hi — calling to schedule a dental cleaning for Brian." }));
  await session.handle(JSON.stringify({ type: "conversation.item.input_audio_transcription.completed", transcript: "We have Tuesday 10 AM or Wednesday 2 PM." }));
  await session.handle(JSON.stringify({ type: "response.done", response: { output: [{ type: "function_call", name: "ask_owner", call_id: "c1", arguments: JSON.stringify({ question: "Tuesday 10 AM or Wednesday 2 PM?", options: ["Tuesday 10 AM", "Wednesday 2 PM"] }) }] } }));
  await session.handle(JSON.stringify({ type: "conversation.item.input_audio_transcription.completed", transcript: "Booked Tuesday 10 AM, confirmation DC-48213." }));
  await session.handle(JSON.stringify({ type: "response.done", response: { output: [{ type: "function_call", name: "report_outcome", call_id: "c2", arguments: JSON.stringify({ status: "success", summary: "Booked Tuesday 10 AM, confirmation DC-48213.", human_or_business_reached: "Riverside Dental receptionist", results: { "appointment date": "Tuesday", "appointment time": "10:00 AM", "confirmation number": "DC-48213" }, commitments_made: ["Cleaning Tuesday 10 AM"], financial_commitments: [], dates_and_times: ["Tuesday 10:00 AM"], confirmation_numbers: ["DC-48213"], follow_up_required: false, follow_up: null, questions_for_brian: [] }) }] } }));
  await session.handle(JSON.stringify({ type: "response.done", response: { output: [{ type: "function_call", name: "end_call", call_id: "c3", arguments: JSON.stringify({ reason: "objective_complete" }) }] } }));
  console.log("--- structured outcome from report_outcome:\n" + JSON.stringify(session.outcome, null, 2));
  process.exit(0);
}

if (arg === "openai-live-session") {
  (config.openaiLive as { apiKey: string }).apiKey ||= "demo-key";
  const env = buildEnvelope(req);
  const ws = new FakeWs();
  const session = new OpenAiLiveSession({
    instructions: buildLiveInstructions(env, { recipient_name: req.recipient_name }),
    backendInstructions: buildAgentInstructions(env, { recipient_name: req.recipient_name, realtime_hold_supported: true, hold_seconds: 45, tools: [...LIVE_TOOL_NAMES] }) + "\n" + backendInstructionsAddendum("Brian"),
    ownerName: "Brian", voice: "marin", wsFactory: () => ws, greetingWaitMs: 50,
    hooks: { onAskOwner: async (q) => { console.log(`\n[needs Brian] ${q}\n[auto-answer for demo] Tuesday`); return "Tuesday"; }, onEndCall: async (r) => console.log(`[hangup] reason=${r}`) },
  });
  session.on("turn", (t) => console.log(`${t.speaker}: ${t.text}`));
  session.on("greeting_fallback", () => console.log("[greeting fallback: callee silent, agent opens]"));
  session.connect();
  ws.emit("open");
  const start = JSON.parse(ws.sent[0]);
  console.log("--- client -> OpenAI:", start.type, JSON.stringify({ model: start.session.model, audio: start.session.audio, delegation: { type: start.session.delegation.type, backend: start.session.delegation.responses.model, tools: start.session.delegation.responses.tools.map((t: { name: string }) => t.name) } }));
  console.log(`--- live session.instructions (${start.session.instructions.length} chars, conversation only):\n` + start.session.instructions + "\n");
  console.log(`--- backend delegation.responses.instructions: ${start.session.delegation.responses.instructions.length} chars (full envelope + authority + tools)\n`);
  await session.handle(JSON.stringify({ type: "session.started", session: { id: "live_demo" } }));
  await session.handle(JSON.stringify({ type: "session.input_transcript.delta", delta: "Riverside Dental, this is Maria.", start_ms: 900, end_ms: 2100 }));
  await session.handle(JSON.stringify({ type: "session.output_transcript.delta", delta: "Hi — I'd like to schedule a dental cleaning for Brian.", start_ms: 2600, end_ms: 5200 }));
  await session.handle(JSON.stringify({ type: "session.input_transcript.delta", delta: "We have Tuesday 10 AM or Wednesday 2 PM.", start_ms: 6000, end_ms: 8500 }));
  await session.handle(JSON.stringify({ type: "session.delegation.created", delegation: { id: "item_d1", type: "delegation", target: "responses" }, response_id: "resp_1" }));
  await session.handle(JSON.stringify({ type: "response.event", delegation_id: "item_d1", event: { type: "response.output_item.done", item: { type: "function_call", status: "completed", call_id: "c1", name: "ask_owner", arguments: JSON.stringify({ question: "Tuesday 10 AM or Wednesday 2 PM?", options: ["Tuesday 10 AM", "Wednesday 2 PM"] }) } } }));
  await session.handle(JSON.stringify({ type: "session.input_transcript.delta", delta: "Booked Tuesday 10 AM, confirmation DC-48213.", start_ms: 15000, end_ms: 18000 }));
  await session.handle(JSON.stringify({ type: "session.delegation.created", delegation: { id: "item_d2", type: "delegation", target: "responses" }, response_id: "resp_2" }));
  await session.handle(JSON.stringify({ type: "response.event", delegation_id: "item_d2", event: { type: "response.output_item.done", item: { type: "function_call", status: "completed", call_id: "c2", name: "report_outcome", arguments: JSON.stringify({ status: "success", summary: "Booked Tuesday 10 AM, confirmation DC-48213.", human_or_business_reached: "Riverside Dental receptionist", results: { "appointment date": "Tuesday", "appointment time": "10:00 AM", "confirmation number": "DC-48213" }, commitments_made: ["Cleaning Tuesday 10 AM"], financial_commitments: [], dates_and_times: ["Tuesday 10:00 AM"], confirmation_numbers: ["DC-48213"], follow_up_required: false, follow_up: null, questions_for_brian: [] }) } } }));
  await session.handle(JSON.stringify({ type: "response.event", delegation_id: "item_d2", event: { type: "response.output_item.done", item: { type: "function_call", status: "completed", call_id: "c3", name: "end_call", arguments: JSON.stringify({ reason: "objective_complete" }) } } }));
  await session.handle(JSON.stringify({ type: "session.closed", reason: "close_requested", usage: { seconds: 61 } }));
  console.log("--- client messages:", ws.sent.map((m) => JSON.parse(m).type).join(", "));
  console.log("--- structured outcome from report_outcome:\n" + JSON.stringify(session.outcome, null, 2));
  process.exit(0);
}

const scenario = arg as ScenarioName;
if (!SCENARIOS[scenario]) { console.error(`unknown scenario "${arg}". options: ${Object.keys(SCENARIOS).join(", ")}, xai-session, openai-live-session`); process.exit(1); }
const store = new CallStore(mkdtempSync(join(tmpdir(), "phone-demo-")));
const svc = new PhoneService({ providers: { mock: new MockProvider({ scenario, ticks: 1 }) }, defaultProvider: "mock", store, useLlmExtraction: false, pollIntervalMs: 50 });
const started = await svc.makeCall({ ...req, provider: "mock" });
console.log("make_call ->", started);
console.log("get_status ->", await svc.getStatus({ task_id: started.task_id }));
const st = await svc.getStatus({ task_id: started.task_id });
if (st.state === "needs_user" && st.pending_question) {
  console.log(`\n[needs Brian] ${st.pending_question.question} options=${JSON.stringify(st.pending_question.options)}`);
  console.log("answer ->", await svc.answerQuestion({ task_id: started.task_id }, st.pending_question.id, "Friday 4 PM"));
}
console.log("get_result ->", JSON.stringify(await svc.getResult({ task_id: started.task_id }), null, 2));
svc.shutdown();
