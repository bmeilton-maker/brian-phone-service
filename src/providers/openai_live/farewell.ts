/**
 * Farewell-intent detection for the GPT-Live bridge. The live model owns the conversation, but the application
 * decides when the line drops: once either side has said goodbye, the bridge lets one short farewell play out and
 * hangs up. These helpers are deliberately conservative (word boundaries, "take care" but not "take care of", "have
 * a good day" but not "a good day for that") because a false positive ends a call.
 */

const FAREWELL_RE = new RegExp(
  [
    "good-?bye",
    "bye-?bye",
    "bye now",
    "bye",
    "have a (?:good|great|nice|wonderful|lovely|blessed|pleasant) (?:day|one|evening|night|afternoon|morning|weekend|rest of (?:the|your) day)",
    "good ?night",
    "take care(?! of)",
    "see you (?:then|soon|tomorrow|later|next|on|at|[a-z]+day)",
    "talk (?:to you )?(?:soon|later|then)",
    "so long",
  ].map((p) => `(?:${p})`).join("|"),
  "i",
);
const FAREWELL_WORD_RE = new RegExp(`\\b(?:${FAREWELL_RE.source})\\b`, "i");

/** True when the text contains a farewell phrase anywhere. */
export function containsFarewell(text: string): boolean {
  return FAREWELL_WORD_RE.test(text);
}

function lastSentence(text: string): string {
  const parts = text.replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "";
}

/**
 * True when the speaker is actually closing: the LAST sentence is a farewell and not a question.
 * "Before we say goodbye, can I confirm the date?" -> false. "You're all set for Tuesday. Goodbye!" -> true.
 */
export function isClosingLine(text: string): boolean {
  const last = lastSentence(text);
  if (!last || last.trim().endsWith("?")) return false;
  return FAREWELL_WORD_RE.test(last);
}

export type HumanUtteranceKind = "farewell" | "ack" | "substantive";

const ACK_WORDS = new Set([
  "ok", "okay", "kay", "yeah", "yes", "yep", "yup", "mhm", "mm", "mmm", "hmm", "uh", "huh", "uh-huh", "mm-hmm", "right", "sure", "great", "perfect",
  "alright", "all", "thanks", "thank", "you", "too", "so", "much", "very", "no", "problem", "worries", "will", "do", "got", "it", "cheers", "good",
  "well", "then", "the", "best", "later", "awesome", "wonderful", "lovely", "appreciate", "sounds", "cool", "fine", "nice", "and", "a", "of", "course",
  "absolutely", "definitely", "certainly", "indeed", "excellent", "brilliant", "fantastic", "ta", "yea", "ya", "aye",
]);

/**
 * Classify what the callee is saying while the agent is closing. Farewells and bare acknowledgements ("okay",
 * "thanks, you too") let the close proceed; anything with real content ("wait", "one more thing", "what time?")
 * means the person is not done and the close must be cancelled.
 */
export function classifyHumanUtterance(text: string): HumanUtteranceKind {
  const cleaned = text.toLowerCase().replace(/[^a-z'\- ]+/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return "ack";
  if (containsFarewell(cleaned)) {
    // "bye, wait, what time was that?" -> substantive
    const rest = cleaned.replace(new RegExp(FAREWELL_WORD_RE.source, "gi"), " ");
    return rest.split(" ").filter(Boolean).every((w) => ACK_WORDS.has(w)) ? "farewell" : "substantive";
  }
  return cleaned.split(" ").filter(Boolean).every((w) => ACK_WORDS.has(w)) ? "ack" : "substantive";
}
