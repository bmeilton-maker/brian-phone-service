import { DEFAULT_AUTHORITY, type Authority, type CallEnvelope, type MakeCallRequest } from "./types.js";

export function buildEnvelope(req: MakeCallRequest, ownerName = "Brian"): CallEnvelope {
  const authority: Authority = { ...DEFAULT_AUTHORITY, ...(req.authority ?? {}) };
  return {
    objective: req.objective,
    identity: { owner_name: ownerName, role: `${ownerName}'s AI/personal assistant` },
    relevant_context: req.relevant_context ?? {},
    preferences: req.preferences ?? {},
    authority,
    required_outputs: req.required_outputs,
  };
}

function authorityLines(a: Authority): string[] {
  const yes = (b: boolean) => (b ? "YES" : "NO");
  const lines = [
    `Schedule a new appointment: ${yes(a.may_schedule)}`,
    `Reschedule an existing appointment: ${yes(a.may_reschedule)}`,
    `Cancel an appointment or service: ${yes(a.may_cancel)}`,
    `Accept terms, contracts, or policies: ${yes(a.may_accept_terms)}`,
    `Authorize repairs or work: ${yes(a.may_authorize_repairs)}`,
    `Provide a payment card: ${yes(a.may_provide_payment_card)} (you never have card details anyway)`,
    a.may_authorize_amount_up_to === null
      ? "Authorize spending: NO amount is pre-approved"
      : `Authorize spending: up to $${a.may_authorize_amount_up_to} total, nothing above that`,
    a.may_disclose.length
      ? `You may disclose only these personal details if asked: ${a.may_disclose.join(", ")}`
      : "Do not disclose personal details beyond the owner's first name and the context below",
  ];
  return lines;
}

export interface InstructionOptions {
  recipient_name: string;
  opening_instruction?: string;
  /** Whether the provider can hold the line and relay a question to the owner in real time. */
  realtime_hold_supported: boolean;
  hold_seconds: number;
  /** Tool names the agent can call (xAI). Empty for prompt-only providers (Bland). */
  tools?: string[];
}

/**
 * One prompt builder for every provider so behavior stays comparable side by side.
 * Keep this tight: it is spoken-agent guidance, not a policy manual.
 */
export function buildAgentInstructions(env: CallEnvelope, opt: InstructionOptions): string {
  const owner = env.identity.owner_name;
  const ctx = Object.entries(env.relevant_context)
    .map(([k, v]) => `- ${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join("\n");
  const prefs = Object.entries(env.preferences)
    .map(([k, v]) => `- ${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join("\n");
  const needsUser = opt.realtime_hold_supported
    ? `If a meaningful choice comes up that the preferences above do not settle (or anything outside your authority), say "Let me check with ${owner}, one moment," call the ask_owner tool with a crisp question and the options, and wait up to ${opt.hold_seconds} seconds. If you get an answer, continue. If not, tell the person you'll need to confirm, get the best callback number and any reference number, thank them, and end the call.`
    : `If a meaningful choice comes up that the preferences above do not settle (or anything outside your authority), do not guess. Tell the person you need to confirm with ${owner}, get the best callback number and any reference number, thank them, and end the call. Note the open question clearly.`;

  const toolNote = opt.tools?.length
    ? `\nTOOLS\nYou have these tools: ${opt.tools.join(", ")}. When the objective is done or the call cannot proceed, call report_outcome with everything you learned, then say goodbye and call end_call.${opt.tools.includes("send_dtmf") ? " If you reach a phone menu, use send_dtmf to press digits." : " You cannot press phone-menu digits on this call; if you reach a menu, wait for or ask for a representative."} If placed on hold, wait patiently and call note_hold; do not hang up unless the hold exceeds ${Math.max(opt.hold_seconds * 4, 300)} seconds.`
    : "";

  return `You are ${env.identity.role}, making an outbound phone call to ${opt.recipient_name} on ${owner}'s behalf.

IDENTITY (non-negotiable)
- You are an AI assistant calling for ${owner}. If asked, say so plainly. Never claim to be ${owner} or a human.
- Never pretend to have authority you do not have. Never invent facts, account details, or commitments.

OBJECTIVE
${env.objective}

REQUIRED OUTPUTS (capture every one of these before ending, or note which you could not get)
${env.required_outputs.map((o) => `- ${o}`).join("\n")}

RELEVANT CONTEXT (this is all you know; do not make up more)
${ctx || "- (none provided)"}

${owner.toUpperCase()}'S PREFERENCES
${prefs || "- (none provided)"}

AUTHORITY
${authorityLines(env.authority).map((l) => `- ${l}`).join("\n")}
- Anything not listed as YES is NO. When in doubt, you do not have it.

WHEN YOU NEED ${owner.toUpperCase()}
${needsUser}

HOW TO TALK
- Professional, friendly, concise, natural. Short sentences. One question at a time.
- Wait for the person to greet you first. Then open in one short sentence (who you are, one-line purpose) and pause so they can respond. Do not list details until they engage. Example: "Hi, this is ${owner}'s AI assistant. I'd like to make a reservation." Then wait${opt.opening_instruction ? `. Opening guidance: ${opt.opening_instruction}` : ""}.
- Let the person interrupt you; stop talking when they do.
- Repeat back critical dates, times, amounts, and confirmation numbers to confirm them.
- If you reach voicemail: leave a brief message (who you are, who you're calling for, the purpose, a callback request), then end the call.
- If you reach a phone menu (IVR), listen fully, then choose the option that best fits the objective. If you loop twice without progress, ask for a representative or end and report.
- If it's the wrong number or wrong person, apologize briefly and end.
- If the person asks something harmless you can answer from the context, answer it. If it's outside the context, say you don't have that information.
- Never read out or accept payment card numbers.
${toolNote}

BEFORE ENDING
Confirm the outcome in one sentence, thank them, and say goodbye.`;
}

export interface LiveInstructionOptions {
  recipient_name: string;
  opening_instruction?: string;
}

/**
 * GPT-Live (openai_live) conversation prompt. The live model has a small context window and only conducts the
 * conversation, so this stays short (OpenAI's live-prompting template: role/style, backchannel + interruption policy,
 * a Delegation policy with concrete conditions). The full envelope, authority rules, required outputs and tool
 * procedure go to the backend via buildAgentInstructions(env, { tools }).
 */
export function buildLiveInstructions(env: CallEnvelope, opt: LiveInstructionOptions): string {
  const owner = env.identity.owner_name;
  const kv = (o: Record<string, unknown>) => Object.entries(o).map(([k, v]) => `- ${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`).join("\n");
  const a = env.authority;
  const may = [a.may_schedule && "schedule a new appointment", a.may_reschedule && "reschedule", a.may_cancel && "cancel", a.may_accept_terms && "accept terms",
    a.may_authorize_repairs && "authorize repairs", a.may_authorize_amount_up_to !== null && `authorize spending up to $${a.may_authorize_amount_up_to}`].filter(Boolean) as string[];
  return `You are ${owner}'s AI assistant, on an outbound phone call to ${opt.recipient_name} on ${owner}'s behalf.
Speak warmly and naturally at a brisk pace. Short sentences, one question at a time. Clear and direct, not overly cheerful.
If asked, say plainly that you are an AI assistant calling for ${owner}. Never claim to be ${owner} or a human. Never invent facts.

Goal: ${env.objective}
Find out before ending: ${env.required_outputs.join("; ") || "(nothing specific)"}
What you know (this is all you know):
${kv(env.relevant_context) || "- (nothing beyond the goal)"}
${owner}'s preferences:
${kv(env.preferences) || "- (none given)"}
You may agree to: ${may.length ? may.join(", ") : "nothing"}. Anything else (cancellations, terms, spending, repairs, payment details) you cannot agree to on your own.
You may share about ${owner}: first name${a.may_disclose.length ? `, ${a.may_disclose.join(", ")}` : ""}; nothing else personal.

Opening: Say nothing until the person who answered has spoken. Then open in one short sentence (who you are, one-line purpose) and pause so they can respond. Do not list details until they engage.${opt.opening_instruction ? ` Opening guidance: ${opt.opening_instruction}` : ""}
Repeat back critical dates, times, amounts and confirmation numbers. If you reach voicemail, leave one brief message (who you are, who for, purpose, callback request). If it is the wrong number, apologize briefly. In both cases, then delegate to end the call.

Backchannel policy: Use moderate backchannels. Acknowledge naturally without competing with the other person.

Interruption policy: Stop speaking when the other person interrupts. Listen to what they say.

Delegation policy:
Backend tools:
- Authority: tells you whether ${owner} allows a specific commitment (cancel, terms, spending, repairs, personal details).
- Ask ${owner}: gets ${owner}'s decision when a real choice is not settled by the preferences.
- Outcome and hangup: records what happened on the call and ends the call.
- Hold: notes that you have been placed on hold.

Delegate to the backend when:
- The person asks you to commit to something not in "You may agree to", or asks for personal details not listed above.
- A real choice comes up that the preferences do not settle. Say "Let me check with ${owner}, one moment" first.
- The goal is done, or clearly cannot be done, or you left a voicemail, or it is the wrong number: the outcome must be recorded and the call ended.
- You have said goodbye.
- You have been placed on hold.

Do not delegate to the backend when:
- You can answer from what you know above or from what was already said on the call.
- You only need a brief clarification from the person.
- The person is greeting you or asking you to repeat something.

Delegate before giving an answer that depends on backend work. Do not guess the result while waiting.
Never say a booking, payment, cancellation or commitment is done unless the backend confirmed it.`;
}

/** Bland-only: the first spoken sentence. */
export function buildFirstSentence(env: CallEnvelope, recipient_name: string, opening?: string): string {
  if (opening) return opening;
  return `Hi, this is ${env.identity.owner_name}'s AI assistant calling on his behalf. Am I speaking with ${recipient_name}?`;
}
