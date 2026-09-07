/**
 * Types for the Evidence Gate.
 *
 * `CallTranscriptTurn` and `CompletionConfidence` mirror the shapes the CALL-E
 * SDK returns (`CallAttempt.transcriptTurns`, `Call.completionConfidence`).
 * They are restated here rather than imported so the gate can be unit-tested
 * against fixtures without constructing a client, and so a change in the SDK
 * surfaces as a type error at the adapter instead of silently reshaping the
 * gate's contract.
 */

export type TranscriptSpeaker = "bot" | "user" | "unknown";

export interface CallTranscriptTurn {
  /** Seconds from the start of the attempt; null when the source line had none. */
  readonly offset_seconds: number | null;
  readonly speaker: TranscriptSpeaker;
  readonly text: string;
}

export interface CompletionConfidence {
  /** 0 to 1. */
  readonly score: number;
  /** Provider label, e.g. `low`, `medium`, `high`. */
  readonly label: string;
}

/**
 * How to recognize that the bot raised one field's topic.
 *
 * `asks` entries are matched against lowercased bot turns: strings as
 * substrings, regular expressions as-is. Write them for the words the bot
 * would actually say, not the field name.
 */
export interface FieldProbe {
  /** Property name in the result schema. */
  readonly field: string;
  /** Required fields must be `verified` for the call to pass the gate. */
  readonly required: boolean;
  readonly asks: readonly (string | RegExp)[];
  /**
   * Values that are present but mean "no answer". Defaults to a standard set
   * including `""`, `"unknown"`, `"unclear"`, `"n/a"` and `"none"`.
   */
  readonly unknownValues?: readonly string[];
}

export type FieldVerdict =
  | "verified"
  | "asked_but_unclear"
  /**
   * A question was asked and answered, but none of this field's probes match
   * it, so the answer cannot be attributed to this field. Withheld, but not
   * accused of being invented — the distinction between "I cannot confirm
   * this" and "this never happened".
   */
  | "unattributed"
  /**
   * No probe matched, but exactly one question went unclaimed and exactly one
   * field went unmatched, so by elimination the answer can only belong here.
   * Weaker evidence than a lexical match and reported separately for that
   * reason. Only produced when `attributeByElimination` is enabled.
   */
  | "attributed"
  | "never_asked"
  | "no_transcript";

export interface FieldReport {
  readonly field: string;
  readonly required: boolean;
  readonly verdict: FieldVerdict;
  /** Whether the raw result carried a usable value for this field. */
  readonly hasValue: boolean;
  /**
   * A value came back for a topic no bot turn raised. This is the case a
   * schema check cannot see, and the reason this module exists.
   */
  readonly unsupported: boolean;
  /**
   * The bot turn that matched this field's probes, verbatim. `null` for every
   * verdict other than `verified` / `asked_but_unclear`. This is the quote a
   * stored fact is allowed to cite; a fact without one is not storable.
   */
  readonly supportingTurn: string | null;
  readonly note: string;
}

export interface GateInput {
  readonly structuredResult: Record<string, unknown> | null;
  /** Bot and user turns for the attempt under review, oldest first. */
  readonly transcriptTurns: readonly CallTranscriptTurn[];
  readonly probes: readonly FieldProbe[];
  readonly completionConfidence?: CompletionConfidence | null;
  /** Defaults to 0.7. */
  readonly minConfidence?: number;
  /**
   * Allow attribution by elimination when it is forced: one unclaimed
   * question, one unmatched field. Off by default, because it rests on the
   * assumption that the agent asked only what the task told it to — reasonable,
   * since the task is the instruction, but not guaranteed.
   */
  readonly attributeByElimination?: boolean;
}

export interface GateReport {
  readonly verdict: "verified" | "needs_human";
  readonly fields: readonly FieldReport[];
  /** Human-readable reasons the call did not pass. Empty when it did. */
  readonly reasons: readonly string[];
  /** Fields that carried a value the call never asked about. */
  readonly unsupportedFields: readonly string[];
  /**
   * Questions the agent asked that no probe claimed, verbatim. These are the
   * raw material for better probes: if one of them is the question you meant
   * to ask, add its wording to that field's `asks`.
   */
  readonly unclaimedQuestions: readonly string[];
  readonly minConfidence: number;
}
