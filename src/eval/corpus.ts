/**
 * A labelled corpus for measuring the Evidence Gate.
 *
 * Every case carries ground truth: whether the bot really raised the topic,
 * and whether a value really came back. The gate never sees the labels — it
 * sees only a transcript and a result, exactly as it would in production.
 *
 * Generation is seeded and deterministic. The same seed produces the same
 * corpus on every machine and every run, so the reported numbers are
 * reproducible rather than a lucky sample.
 *
 * The corpus deliberately includes cases the gate is expected to get wrong.
 * `asked_paraphrase` phrases the question using none of the probe vocabulary,
 * which a lexical matcher cannot see. Measuring that cost is the point: a
 * benchmark that only contains cases the system handles is marketing.
 */

import type { CallTranscriptTurn } from "../evidence/types.js";

export type CaseKind =
  | "asked_direct_answered"
  | "asked_direct_unclear"
  | "not_asked_value_returned"
  | "not_asked_no_value"
  | "asked_paraphrase_answered";

export interface EvalCase {
  readonly id: string;
  readonly kind: CaseKind;
  readonly field: string;
  readonly transcript: readonly CallTranscriptTurn[];
  readonly structuredResult: Record<string, unknown> | null;
  /** Ground truth: did a bot turn genuinely raise this topic? */
  readonly trulyAsked: boolean;
  /** Ground truth: did a usable value come back? */
  readonly trulyAnswered: boolean;
}

/** Deterministic PRNG (mulberry32). No global state, no Math.random. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface FieldTemplate {
  readonly field: string;
  /** Phrasings that contain the probe vocabulary. */
  readonly directAsks: readonly string[];
  /** Phrasings that avoid it entirely — the hard case. */
  readonly paraphraseAsks: readonly string[];
  readonly answers: readonly string[];
  readonly unclearReplies: readonly string[];
  readonly value: string;
}

/**
 * Probe vocabulary lives in `PROBE_VOCABULARY` below and is deliberately kept
 * out of the paraphrase phrasings, so `asked_paraphrase` really is invisible
 * to a substring matcher rather than accidentally detectable.
 */
const TEMPLATES: readonly FieldTemplate[] = [
  {
    field: "accepts_new_patients",
    directAsks: [
      "Are you accepting new patients at the moment?",
      "I wanted to check whether you accept new patients right now.",
    ],
    paraphraseAsks: [
      "If someone has never been seen at your office before, could they book?",
      "Is your list open, or are you full for the foreseeable future?",
    ],
    answers: ["Yes, we are.", "We are, for general visits."],
    unclearReplies: ["I really couldn't say, you'd have to ask the office manager."],
    value: "yes",
  },
  {
    field: "reference_status",
    directAsks: [
      "Can you confirm the current status of reference 88431?",
      "I am calling about the status of reference 88431.",
    ],
    paraphraseAsks: [
      "Where does file 88431 stand at the moment?",
      "Has anything moved on 88431 since last week?",
    ],
    answers: ["That one is still in review.", "It is under review."],
    unclearReplies: ["The system is down, I can't pull it up."],
    value: "in_review",
  },
  {
    field: "part_in_stock",
    directAsks: [
      "Do you have that part in stock today?",
      "I need to know if the part is in stock.",
    ],
    paraphraseAsks: [
      "Could you ship one out this afternoon if I ordered now?",
      "Is there one sitting on the shelf, or is it a special order?",
    ],
    answers: ["We have two on the shelf.", "Yes, we have them."],
    unclearReplies: ["Inventory hasn't been counted since Friday."],
    value: "yes",
  },
  {
    field: "reached_department",
    directAsks: [
      "Am I through to the account services department?",
      "Is this the right department for account services?",
    ],
    paraphraseAsks: [
      "Am I speaking with someone who handles existing customer files?",
      "Have I landed in the right place for account questions?",
    ],
    answers: ["Yes, you are.", "That's us."],
    unclearReplies: ["Sort of, I can try to help."],
    value: "yes",
  },
];

/** The probe vocabulary the gate is configured with, kept beside the corpus. */
export const PROBE_VOCABULARY: Record<string, readonly string[]> = {
  accepts_new_patients: ["new patients", "accepting new"],
  reference_status: ["reference", "status of"],
  part_in_stock: ["in stock", "stock today"],
  reached_department: ["department", "through to"],
};

const GREETING: CallTranscriptTurn[] = [
  { offset_seconds: 2, speaker: "user", text: "Good morning, how can I help you?" },
  {
    offset_seconds: 5,
    speaker: "bot",
    text: "Hello, I am an automated assistant calling on behalf of a customer.",
  },
];

const FAREWELL: CallTranscriptTurn = {
  offset_seconds: 40,
  speaker: "bot",
  text: "Thank you for your time. Goodbye.",
};

const pick = <T>(items: readonly T[], rand: () => number): T =>
  items[Math.floor(rand() * items.length)]!;

const KINDS: readonly CaseKind[] = [
  "asked_direct_answered",
  "asked_direct_unclear",
  "not_asked_value_returned",
  "not_asked_no_value",
  "asked_paraphrase_answered",
];

function buildCase(id: string, kind: CaseKind, template: FieldTemplate, rand: () => number): EvalCase {
  const turns: CallTranscriptTurn[] = [...GREETING];
  let trulyAsked = false;
  let trulyAnswered = false;
  let value: string | null = null;

  switch (kind) {
    case "asked_direct_answered":
      turns.push({ offset_seconds: 12, speaker: "bot", text: pick(template.directAsks, rand) });
      turns.push({ offset_seconds: 18, speaker: "user", text: pick(template.answers, rand) });
      trulyAsked = true;
      trulyAnswered = true;
      value = template.value;
      break;

    case "asked_direct_unclear":
      turns.push({ offset_seconds: 12, speaker: "bot", text: pick(template.directAsks, rand) });
      turns.push({ offset_seconds: 18, speaker: "user", text: pick(template.unclearReplies, rand) });
      trulyAsked = true;
      value = "unknown";
      break;

    case "not_asked_value_returned":
      // The bot never raised it, yet a confident value comes back anyway.
      turns.push({ offset_seconds: 12, speaker: "bot", text: "Thanks, I have what I need." });
      value = template.value;
      break;

    case "not_asked_no_value":
      turns.push({ offset_seconds: 12, speaker: "bot", text: "Thanks, I have what I need." });
      value = null;
      break;

    case "asked_paraphrase_answered":
      // Genuinely asked, using none of the probe vocabulary.
      turns.push({ offset_seconds: 12, speaker: "bot", text: pick(template.paraphraseAsks, rand) });
      turns.push({ offset_seconds: 18, speaker: "user", text: pick(template.answers, rand) });
      trulyAsked = true;
      trulyAnswered = true;
      value = template.value;
      break;
  }

  turns.push(FAREWELL);

  return {
    id,
    kind,
    field: template.field,
    transcript: turns,
    structuredResult: value === null ? null : { [template.field]: value },
    trulyAsked,
    trulyAnswered,
  };
}

/**
 * Build `size` labelled cases, evenly distributed across kinds and fields.
 *
 * Even distribution is intentional: the rates reported by the harness are
 * per-class, so an unbalanced corpus would make them harder to read, not more
 * realistic.
 */
export function buildCorpus(size: number, seed = 20260906): EvalCase[] {
  const rand = mulberry32(seed);
  const cases: EvalCase[] = [];
  for (let i = 0; i < size; i += 1) {
    const kind = KINDS[i % KINDS.length]!;
    const template = TEMPLATES[Math.floor(i / KINDS.length) % TEMPLATES.length]!;
    cases.push(buildCase(`case-${String(i + 1).padStart(4, "0")}`, kind, template, rand));
  }
  return cases;
}
