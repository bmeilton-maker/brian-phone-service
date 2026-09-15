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

/** Words that can trail a goodbye, or make up a bare acknowledgement, without carrying new content. */
const ACK_WORDS = new Set([
  "ok", "okay", "kay", "yeah", "yes", "yep", "yup", "mhm", "mm", "mmm", "hmm", "uh", "huh", "uh-huh", "mm-hmm", "right", "sure", "great", "perfect",
  "alright", "all", "thanks", "thank", "you", "too", "so", "much", "very", "no", "problem", "worries", "will", "do", "got", "it", "cheers", "good",
  "well", "then", "the", "best", "later", "awesome", "wonderful", "lovely", "appreciate", "sounds", "cool", "fine", "nice", "and", "a", "of", "course",
  "absolutely", "definitely", "certainly", "indeed", "excellent", "brilliant", "fantastic", "ta", "yea", "ya", "aye",
]);

/** True when the text contains a farewell phrase anywhere. */
export function containsFarewell(text: string): boolean {
  return FAREWELL_WORD_RE.test(text);
}

function lastSentence(text: string): string {
  const parts = text.replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "";
}

function words(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z'\- ]+/g, " ").split(/\s+/).filter(Boolean);
}

/** Text after the last farewell phrase in `sentence`, or null when the sentence has none. */
function tailAfterFarewell(sentence: string): string | null {
  const re = new RegExp(FAREWELL_WORD_RE.source, "gi");
  let last: RegExpExecArray | null = null;
  for (let m = re.exec(sentence); m; m = re.exec(sentence)) last = m;
  return last ? sentence.slice(last.index + last[0].length) : null;
}

/**
 * True when the speaker is actually closing: the LAST sentence ends on a farewell (at most a name or a filler after
 * it) and is not a question. "Before we say goodbye, can I confirm the date?" -> false. "Goodbye, Maria!" -> true.
 */
export function isClosingLine(text: string): boolean {
  const last = lastSentence(text);
  if (!last || last.trim().endsWith("?")) return false;
  const tail = tailAfterFarewell(last);
  if (tail === null) return false;
  const rest = words(tail);
  return rest.length <= 2 || rest.every((w) => ACK_WORDS.has(w));
}

export type HumanUtteranceKind = "farewell" | "ack" | "substantive";

/**
 * Classify the callee's running utterance. A farewell is a last sentence that ends on a goodbye (only
 * acknowledgements may follow it), whatever came before: "Sure, Tuesday works. Thanks, bye!" -> farewell. Bare
 * acknowledgements ("okay", "thanks, you too") are "ack". Anything with real content, including a goodbye that the
 * person then talks past ("bye... oh wait, one more thing"), is "substantive": they are not done.
 */
export function classifyHumanUtterance(text: string): HumanUtteranceKind {
  const all = words(text);
  if (!all.length) return "ack";
  const last = lastSentence(text);
  if (!last.trim().endsWith("?")) {
    const tail = tailAfterFarewell(last);
    if (tail !== null && words(tail).every((w) => ACK_WORDS.has(w))) return "farewell";
  }
  return all.every((w) => ACK_WORDS.has(w)) ? "ack" : "substantive";
}
