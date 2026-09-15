import type { CallState, PhoneProvider, ProviderCallOutcome, StartCallInput, StartCallResult, TranscriptTurn, NormalizedResult } from "../types.js";

/**
 * MockProvider: scripted scenarios for tests, CI, and the demo. No network.
 * Scenario is chosen by phone_number suffix (see SCENARIOS) or by constructor override.
 */
export type ScenarioName =
  | "info_request" | "scheduling" | "harmless_question" | "needs_user" | "voicemail" | "ivr" | "hold"
  | "interruptions" | "call_drop" | "cannot_complete" | "busy" | "invalid_number" | "wrong_person" | "provider_error";

interface Scenario {
  turns: TranscriptTurn[];
  human_answered: boolean;
  voicemail: boolean;
  error: string | null;
  duration: number;
  needs_user?: { question: string; options?: string[] };
  provider_extraction?: Partial<NormalizedResult>;
  fail_start?: boolean;
}

const A = (text: string): TranscriptTurn => ({ speaker: "assistant", text });
const H = (text: string): TranscriptTurn => ({ speaker: "human", text });
const S = (text: string): TranscriptTurn => ({ speaker: "system", text });

export const SCENARIOS: Record<ScenarioName, Scenario> = {
  info_request: {
    human_answered: true, voicemail: false, error: null, duration: 95,
    turns: [A("Hi — calling about a standard oil change for Brian. I'm checking whether you have availability this week and what it costs."),
      H("Sure. Standard synthetic is $79.99 and we have openings Thursday and Friday afternoons."),
      A("Great, so $79.99 and Thursday or Friday afternoon. Thanks, I'll pass that along. Goodbye.")],
    provider_extraction: { status: "success", results: { price: "$79.99", availability: "Thursday or Friday afternoon" }, summary: "Synthetic oil change is $79.99; openings Thursday and Friday afternoons." },
  },
  scheduling: {
    human_answered: true, voicemail: false, error: null, duration: 140,
    turns: [A("Hi — I'd like to schedule a dental cleaning for Brian."),
      H("We have Tuesday at 10 AM or Wednesday at 2 PM."),
      A("Tuesday at 10 AM works. Can you confirm that and give me a confirmation number?"),
      H("Booked. Tuesday at 10 AM, confirmation number DC-48213."),
      A("Tuesday at 10 AM, confirmation DC-48213. Thank you, goodbye.")],
    provider_extraction: { status: "success", dates_and_times: ["Tuesday 10:00 AM"], confirmation_numbers: ["DC-48213"], commitments_made: ["Dental cleaning booked Tuesday 10:00 AM"], results: { "appointment date": "Tuesday", "appointment time": "10:00 AM", "confirmation number": "DC-48213" }, summary: "Booked dental cleaning Tuesday 10 AM, confirmation DC-48213." },
  },
  harmless_question: {
    human_answered: true, voicemail: false, error: null, duration: 110,
    turns: [A("Hi — calling to confirm Brian's Friday appointment."),
      H("Wait, am I talking to a robot?"),
      A("Yes, I'm an AI assistant calling on Brian's behalf. Happy to continue or Brian can call back."),
      H("That's fine. Friday at 3 is confirmed."),
      A("Friday at 3 PM confirmed. Thanks, goodbye.")],
    provider_extraction: { status: "success", dates_and_times: ["Friday 3:00 PM"], summary: "Friday 3 PM appointment confirmed. Receptionist asked if I was a robot; I confirmed I'm an AI assistant." },
  },
  needs_user: {
    human_answered: true, voicemail: false, error: null, duration: 160,
    needs_user: { question: "Only 8 AM Monday or 4 PM Friday are open this week. Which does Brian prefer, or wait for next week?", options: ["Monday 8 AM", "Friday 4 PM", "Wait"] },
    turns: [A("Hi — calling to schedule a furnace inspection for Brian."),
      H("This week I only have Monday 8 AM or Friday 4 PM."),
      A("Let me check with Brian, one moment."),
      S("[hold: no answer within window]"),
      A("I'll need to confirm with Brian. What's the best number to call back, and is there a reference for this request?"),
      H("Call 614-555-0100, reference FI-2291."),
      A("Thanks, we'll call back. Goodbye.")],
    provider_extraction: { status: "needs_user", questions_for_brian: ["Monday 8 AM or Friday 4 PM for the furnace inspection, or wait for next week?"], confirmation_numbers: ["FI-2291"], follow_up_required: true, follow_up: { action: "Call back 614-555-0100 with chosen slot", by_whom: "assistant", contact: "614-555-0100" }, summary: "Two slots offered that preferences don't settle; took callback number and reference FI-2291." },
  },
  voicemail: {
    human_answered: false, voicemail: true, error: null, duration: 35,
    turns: [S("[voicemail detected]"), A("Hi, this is Brian Meilton's AI assistant calling about rescheduling his appointment. Please call Brian back at your convenience. Thank you.")],
  },
  ivr: {
    human_answered: true, voicemail: false, error: null, duration: 210,
    turns: [S("[IVR] For appointments press 1, for billing press 2."), S("[dtmf 1]"), S("[IVR] Please hold for the next representative."),
      H("Appointments, how can I help?"), A("Hi — I'd like to confirm Brian's appointment on the 14th."),
      H("Confirmed, 9 AM on the 14th."), A("9 AM on the 14th, confirmed. Thanks, goodbye.")],
    provider_extraction: { status: "success", dates_and_times: ["the 14th 9:00 AM"], summary: "Navigated IVR (pressed 1), reached appointments, confirmed 9 AM on the 14th." },
  },
  hold: {
    human_answered: true, voicemail: false, error: null, duration: 480,
    turns: [H("Please hold."), S("[hold 6 min]"), H("Thanks for holding. How can I help?"),
      A("Hi — calling about the status of order 77812."), H("It shipped today, arrives Thursday."),
      A("Shipped today, arriving Thursday. Thanks, goodbye.")],
    provider_extraction: { status: "success", results: { "order status": "shipped today, arrives Thursday" }, summary: "After a 6 minute hold, confirmed order 77812 shipped today and arrives Thursday." },
  },
  interruptions: {
    human_answered: true, voicemail: false, error: null, duration: 120,
    turns: [A("Hi — calling about Brian Meilton's—"), H("Who?"), A("I'm calling for Brian Meilton."), H("What about?"),
      A("Rescheduling his Thursday appointment."), H("Hold on— okay, what day?"), A("Any morning next week."), H("Tuesday 9."),
      A("Tuesday at 9 AM. Confirmed, thank you.")],
    provider_extraction: { status: "success", dates_and_times: ["Tuesday 9:00 AM"], summary: "Rescheduled to Tuesday 9 AM despite repeated interruptions." },
  },
  call_drop: {
    human_answered: true, voicemail: false, error: "call_dropped", duration: 40,
    turns: [A("Hi — calling about Brian's appointment."), H("Hi, one sec—"), S("[call disconnected]")],
  },
  cannot_complete: {
    human_answered: true, voicemail: false, error: null, duration: 90,
    turns: [A("Hi — I'd like to cancel Brian's membership."),
      H("Only the account holder can do that, in person or via the app."),
      A("Understood. I'll let Brian know. Is there a reference number for this call?"), H("No, just have him use the app."), A("Thank you, goodbye.")],
    provider_extraction: { status: "failed", summary: "Business requires the account holder to cancel in person or via the app. Not completed.", follow_up_required: true, follow_up: { action: "Cancel membership yourself via the app or in person", by_whom: "brian" } },
  },
  busy: { human_answered: false, voicemail: false, error: "busy", duration: 0, turns: [] },
  invalid_number: { human_answered: false, voicemail: false, error: "invalid_number", duration: 0, turns: [], fail_start: true },
  wrong_person: {
    human_answered: true, voicemail: false, error: null, duration: 30,
    turns: [A("Hi — calling about an appointment for Brian. Is this Riverside Dental?"), H("No, wrong number."), A("Sorry about that. Goodbye.")],
    provider_extraction: { status: "failed", human_or_business_reached: "wrong number", summary: "Wrong number; the person said it was not Riverside Dental." },
  },
  provider_error: { human_answered: false, voicemail: false, error: "provider_error", duration: 0, turns: [], fail_start: true },
};

/** Suffix -> scenario, so callers can pick a scenario by number in demo mode. */
export const SCENARIO_BY_SUFFIX: Record<string, ScenarioName> = {
  "0001": "info_request", "0002": "scheduling", "0003": "harmless_question", "0004": "needs_user", "0005": "voicemail",
  "0006": "ivr", "0007": "hold", "0008": "interruptions", "0009": "call_drop", "0010": "cannot_complete",
  "0011": "busy", "0012": "invalid_number", "0013": "wrong_person", "0014": "provider_error",
};

interface MockCall { scenario: Scenario; name: ScenarioName; started: number; cancelled: boolean; answered: string | null; ticks: number }

export class MockProvider implements PhoneProvider {
  readonly name = "mock" as const;
  private calls = new Map<string, MockCall>();
  private n = 0;
  /** ticks: number of getOutcome polls before the call "ends" (lets tests observe in_progress). */
  constructor(private opts: { scenario?: ScenarioName; ticks?: number } = {}) {}

  async startCall(input: StartCallInput): Promise<StartCallResult> {
    const name = this.opts.scenario ?? SCENARIO_BY_SUFFIX[input.phone_number.slice(-4)] ?? "info_request";
    const scenario = SCENARIOS[name];
    if (scenario.fail_start) throw new Error(`mock provider: ${scenario.error}`);
    const call_id = `mock_${++this.n}_${name}`;
    this.calls.set(call_id, { scenario, name, started: Date.now(), cancelled: false, answered: null, ticks: this.opts.ticks ?? 0 });
    return { call_id, state: "queued", raw: { scenario: name } };
  }

  async getOutcome(call_id: string): Promise<ProviderCallOutcome> {
    const c = this.calls.get(call_id);
    if (!c) throw new Error(`mock: unknown call ${call_id}`);
    const s = c.scenario;
    const pendingHold = s.needs_user && !c.answered;
    if (c.ticks > 0) {
      c.ticks--;
      const state: CallState = pendingHold && c.ticks === 0 ? "needs_user" : "in_progress";
      return { call_id, ended: false, state, human_answered: null, voicemail: null, duration_seconds: null, transcript: "", transcript_turns: [], recording_reference: null, error: null, cost_usd: null, provider_extraction: null,
        raw: { provider: "mock", scenario: c.name, ...(state === "needs_user" ? { pending_question: s.needs_user } : {}) } };
    }
    const turns = c.answered ? s.turns.map((t) => (t.text.startsWith("[hold") ? S(`[owner answered: ${c.answered}]`) : t)) : s.turns;
    const extraction = c.answered && s.needs_user
      ? { status: "success" as const, summary: `Owner answered "${c.answered}"; completed accordingly.`, questions_for_brian: [], follow_up_required: false, follow_up: null }
      : s.provider_extraction ?? null;
    return {
      call_id, ended: true,
      state: c.cancelled ? "cancelled" : s.error ? "failed" : "completed",
      human_answered: s.human_answered, voicemail: s.voicemail, duration_seconds: s.duration,
      transcript: turns.map((t) => `${t.speaker}: ${t.text}`).join("\n"), transcript_turns: turns,
      recording_reference: s.duration ? `mock://recording/${call_id}` : null,
      error: c.cancelled ? "cancelled" : s.error, cost_usd: Number((s.duration / 60 * 0.09).toFixed(3)),
      provider_extraction: extraction,
      raw: { provider: "mock", scenario: c.name, answered: c.answered },
    };
  }

  async cancelCall(call_id: string) {
    const c = this.calls.get(call_id);
    if (!c) return { cancelled: false, message: "unknown call" };
    c.cancelled = true; c.ticks = 0;
    return { cancelled: true };
  }

  async answerQuestion(call_id: string, _question_id: string, answer: string) {
    const c = this.calls.get(call_id);
    if (!c || !c.scenario.needs_user) return { delivered: false, message: "no pending question" };
    c.answered = answer; c.ticks = 0;
    return { delivered: true };
  }
}
