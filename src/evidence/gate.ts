/**
 * The Evidence Gate.
 *
 * ── The problem ────────────────────────────────────────────────────────────
 * CALL-E issue #316: a participant asked for an address confirmation, the
 * agent never asked the question during the call, and the result still came
 * back populated — `address_correct: "unclear"`. The reporter only noticed
 * because the summary happened to mention the agent moving on. Their point,
 * quoted from the issue, is that the returned value "alone does not prove"
 * anything: a schema-valid result does not tell you whether the question
 * reached the person.
 *
 * That is the difference between a call result and evidence. `structured_result`
 * says what the model concluded. It does not say what was said out loud.
 *
 * ── What this does ─────────────────────────────────────────────────────────
 * Every field in the result schema is checked against the transcript turns the
 * bot actually spoke. Six verdicts:
 *
 *   verified          the bot raised the topic and a usable value came back
 *   asked_but_unclear the bot raised the topic and the answer was not usable
 *   unattributed      some question was asked and answered, but no probe for
 *                     this field matches it, so the answer cannot be pinned here
 *   attributed        no probe matched, but exactly one question went unclaimed
 *                     and this was the only unmatched field, so by elimination
 *                     the answer can only be this one (opt-in)
 *   never_asked       no bot turn raised the topic
 *   no_transcript     there is no transcript, so nothing can be checked
 *
 * The one that matters is a field carrying a confident-looking value whose
 * topic was never spoken *and* for which no unclaimed exchange exists. That is
 * `never_asked` with `unsupported: true`, and it is the case a plain schema
 * check cannot see. `unattributed` exists so that a genuinely asked question,
 * phrased in words the probes do not contain, is withheld without being
 * accused of having been invented — those are different states.
 *
 * ── What this does not do ──────────────────────────────────────────────────
 * Topic detection is lexical. A probe is a list of substrings and regular
 * expressions, matched case-insensitively against bot turns. It will miss a
 * paraphrase that shares no vocabulary with its probes, and it will fire on a
 * bot turn that mentions the topic without actually asking about it. It is a
 * floor, not a proof: it catches fields the call never went near. Probe
 * quality is the operator's job, and `test/evidence-gate.test.ts` is where the
 * failure modes are pinned down.
 *
 * ── A limit a real call exposed ────────────────────────────────────────────
 * The gate credits a field when a question was asked about it. It has no way
 * to credit a fact established by *absence*.
 *
 * On a real call the agent was told to stay in an automated menu and never ask
 * for a person. It came back with `reached_human: "no"` and
 * `department_confirmed: "no"` — both correct, and both flagged, because no
 * turn asked either question. Nothing established them; they were true because
 * nothing happened.
 *
 * That is the gate behaving exactly as specified and being unhelpful anyway.
 * Withholding a correct negative is the safe direction, but it is a real cost
 * and worth knowing before you write probes for an outcome that is proved by
 * what did not occur.
 *
 * The gate never repairs a value. It reports, and it withholds.
 */

import type { CallTranscriptTurn, FieldVerdict, GateInput, GateReport, FieldReport, FieldProbe } from "./types.js";

/** Values that are present in the JSON but mean "no answer". */
const DEFAULT_UNKNOWN_VALUES = ["", "unknown", "unclear", "n/a", "na", "none", "null"];

/** Below this, a call is not allowed to speak for itself. */
export const DEFAULT_MIN_CONFIDENCE = 0.7;

/**
 * Prose that reports *not having found out*.
 *
 * `unknownValues` covers a field whose answer is an enumerated token, where
 * "I don't know" arrives as `"unknown"`. It cannot cover a field whose answer
 * is prose, because there the model says so in a sentence. A live call to a
 * carrier's automated line returned a value that was a whole sentence saying
 * no explanation had been given and the call had ended before the question was
 * answered.
 *
 * That is not an answer. It is a report that there was no answer, and the gate
 * called it `verified` — the exact failure this file exists to prevent.
 *
 * These patterns are a heuristic, and heuristics were abandoned elsewhere in
 * this project for good reason. What makes this one defensible is the
 * direction it fails in: a false match withholds a real answer, which is the
 * cost this design already publishes and prefers. A false match on the
 * traversal check claimed a success that never happened. Withholding is
 * recoverable by a person reading the transcript; a stored non-fact is not.
 *
 * `asked_prose_non_answer` and `asked_prose_answered` in the evaluation corpus
 * measure both directions, so the trade is a number rather than a hope.
 */
const NON_ANSWER_PATTERNS: readonly RegExp[] = [
  /\bno\s+(?:\w+\s+){0,2}(?:answer|explanation|information|response|details?|confirmation|value)\b/i,
  /\b(?:not|never)\s+(?:\w+\s+){0,2}(?:provided|given|obtained|offered|available|received|determined|confirmed|established|disclosed|stated|specified|answered)\b/i,
  /\b(?:could|would|did|was|were)\s*n(?:o|')t\s+(?:\w+\s+){0,2}(?:provide|obtain|determine|confirm|establish|answer|say|state|get)\b/i,
  /\bunable to\b/i,
  /\bcould not be\s+(?:determined|obtained|confirmed|established|verified|provided)\b/i,
];

/**
 * Prose only. A short enumerated value is an answer and must never be read as
 * the absence of one — "no" is a perfectly good reply to "are you accepting
 * new patients", and reading it as a non-answer would be its own silent bug.
 */
function reportsNonAnswer(text: string): boolean {
  if (text.split(/\s+/).length < 4) return false;
  return NON_ANSWER_PATTERNS.some((pattern) => pattern.test(text));
}

function isUsableValue(value: unknown, unknownValues: readonly string[]): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (unknownValues.includes(trimmed.toLowerCase())) return false;
    return !reportsNonAnswer(trimmed);
  }
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/**
 * Does this turn actually request something, rather than merely name a topic?
 *
 * A live call forced this distinction. The agent introduced itself as "an
 * automated assistant checking the National Weather Service Seattle forecast
 * for today", never asked anything, and the gate credited the field because
 * the probe words were sitting in that sentence. A statement of purpose is not
 * a question, and crediting one is the exact failure this file exists to
 * prevent — arrived at from the opposite direction.
 *
 * A question mark is the clearest signal and not the only one: "I wanted to
 * check whether you accept new patients" asks something without one. So the
 * test is a question mark or an explicit request construction. It stays
 * deliberately narrow: a turn that only *mentions* the topic no longer counts,
 * and `test/eval.test.ts` measures what that costs in both directions.
 */
const REQUEST_SIGNALS: readonly RegExp[] = [
  /\?/,
  /\bi (?:wanted|want|need|would like|was hoping)\s+to\s+(?:check|know|ask|confirm|find out|hear)\b/i,
  /\bi(?:'m| am)\s+calling\s+(?:about|to ask|to check|to confirm)\b/i,
  /\b(?:could|can|would|will)\s+you\b/i,
  /\b(?:tell|let)\s+me\s+(?:if|whether|what|when)\b/i,
];

function requestsSomething(text: string): boolean {
  return REQUEST_SIGNALS.some((pattern) => pattern.test(text));
}

/**
 * The first bot turn that both matches this field's probes and actually asks
 * for something. A turn that names the topic without requesting anything is
 * not a question and does not support a field.
 */
function findSupportingTurn(
  botTurns: readonly string[],
  probe: FieldProbe,
): string | null {
  const hit = botTurns.find(
    (text) =>
      requestsSomething(text) &&
      probe.asks.some((ask) =>
        typeof ask === "string"
          ? text.toLowerCase().includes(ask.toLowerCase())
          : ask.test(text.toLowerCase()),
      ),
  );
  return hit ?? null;
}

function judgeField(
  probe: FieldProbe,
  result: Record<string, unknown> | null,
  botText: readonly string[],
  hasTranscript: boolean,
  unclaimedCount: number,
  /** Set when elimination is enabled and this field is the forced match. */
  eliminationTurn: string | null,
): FieldReport {
  const unknownValues = probe.unknownValues ?? DEFAULT_UNKNOWN_VALUES;
  const value = result?.[probe.field];
  const hasValue = isUsableValue(value, unknownValues);

  if (!hasTranscript) {
    return {
      field: probe.field,
      required: probe.required,
      verdict: "no_transcript",
      hasValue,
      unsupported: false,
      supportingTurn: null,
      note: "No transcript turns were returned, so it cannot be shown that this was asked.",
    };
  }

  const supportingTurn = findSupportingTurn(botText, probe);
  const asked = supportingTurn !== null;

  let verdict: FieldVerdict;
  if (asked && hasValue) verdict = "verified";
  else if (asked) verdict = "asked_but_unclear";
  else if (hasValue && eliminationTurn !== null) verdict = "attributed";
  else if (hasValue && unclaimedCount > 0) verdict = "unattributed";
  else verdict = "never_asked";

  // Only a value with no exchange left to hang on is called invented. If some
  // question was asked and answered that no probe claims, this field might be
  // its answer — we cannot tell, and saying so is not the same as accusing.
  const unsupported = verdict === "never_asked" && hasValue;

  const note = unsupported
    ? "A value was returned, and every question the call asked is accounted for by another field. Nothing was asked that this could answer."
    : verdict === "never_asked"
      ? "No bot turn raised this topic."
      : verdict === "attributed"
        ? "No probe matched, but exactly one question went unclaimed and this was the only unmatched field, so the answer can only have come from it."
      : verdict === "unattributed"
        ? "A question was asked and answered, but no probe for this field matches it, so the answer cannot be attributed here."
        : verdict === "asked_but_unclear"
          ? "The bot raised this topic but no usable answer came back."
          : "A bot turn raised this topic and a usable answer came back.";

  return {
    field: probe.field,
    required: probe.required,
    verdict,
    hasValue,
    unsupported,
    supportingTurn: asked ? supportingTurn : eliminationTurn,
    note,
  };
}

/**
 * Count question-and-answer exchanges that no probe claims.
 *
 * A bot turn containing a question mark, immediately followed by a turn from
 * the other party, is an exchange. If some probe matches that bot turn, the
 * exchange belongs to that field. What is left over is the room in which an
 * unmatched field's answer could plausibly live — a paraphrase the probes
 * cannot see.
 *
 * When nothing is left over, a field carrying a value has no exchange to have
 * come from, and that is the case worth flagging.
 */
function unclaimedExchanges(
  turns: readonly CallTranscriptTurn[],
  probes: readonly FieldProbe[],
): string[] {
  const unclaimed: string[] = [];
  for (let i = 0; i < turns.length - 1; i += 1) {
    const current = turns[i]!;
    const next = turns[i + 1]!;
    if (current.speaker !== "bot" || !current.text.includes("?")) continue;
    if (next.speaker === "bot") continue; // nobody answered

    const text = current.text.toLowerCase();
    const claimed = probes.some((probe) =>
      probe.asks.some((ask) =>
        typeof ask === "string" ? text.includes(ask.toLowerCase()) : ask.test(text),
      ),
    );
    if (!claimed) unclaimed.push(current.text);
  }
  return unclaimed;
}

/** Flatten the bot's spoken turns to lowercased text, oldest first. */
export function botTurnText(turns: readonly CallTranscriptTurn[]): string[] {
  // Original case is preserved: these strings are quoted into stored facts.
  // Matching lowercases at comparison time instead.
  return turns.filter((turn) => turn.speaker === "bot").map((turn) => turn.text);
}

/**
 * Run the gate.
 *
 * The overall verdict is `verified` only when every *required* field is
 * `verified` and the call's completion confidence clears the floor. Anything
 * else is `needs_human` with the reasons spelled out — there is no third
 * outcome and no partial pass, because "mostly verified" is how an unverified
 * fact reaches a database.
 */
export function runEvidenceGate(input: GateInput): GateReport {
  const minConfidence = input.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const botText = botTurnText(input.transcriptTurns);
  const hasTranscript = input.transcriptTurns.length > 0;

  const unclaimed = unclaimedExchanges(input.transcriptTurns, input.probes);

  // Elimination is only allowed when it is forced: one question nobody
  // claimed, one field nobody matched. Two of each is a guess, and a guess is
  // exactly what this module exists to refuse.
  let eliminationFor: string | null = null;
  if (input.attributeByElimination === true && unclaimed.length === 1) {
    const unmatchedWithValue = input.probes.filter((probe) => {
      const value = input.structuredResult?.[probe.field];
      const unknownValues = probe.unknownValues ?? DEFAULT_UNKNOWN_VALUES;
      return findSupportingTurn(botText, probe) === null && isUsableValue(value, unknownValues);
    });
    if (unmatchedWithValue.length === 1) eliminationFor = unmatchedWithValue[0]!.field;
  }

  const fields = input.probes.map((probe) =>
    judgeField(
      probe,
      input.structuredResult,
      botText,
      hasTranscript,
      unclaimed.length,
      probe.field === eliminationFor ? unclaimed[0]! : null,
    ),
  );

  const reasons: string[] = [];

  if (!hasTranscript) {
    reasons.push("No transcript turns were returned for this call.");
  }

  const unsupported = fields.filter((f) => f.unsupported);
  for (const field of unsupported) {
    reasons.push(`\`${field.field}\` carries a value the call never asked about.`);
  }

  for (const field of fields) {
    if (!field.required) continue;
    // `attributed` passes only because the caller opted into elimination; the
    // field report still says the attribution was forced rather than matched.
    if (field.verdict === "verified" || field.verdict === "attributed") continue;
    if (field.unsupported) continue; // already reported above
    reasons.push(`Required field \`${field.field}\`: ${field.verdict}.`);
  }

  // "Verified" has to mean something was established, not that nothing was
  // demanded. With every field optional the loop above adds no reasons and the
  // call passes having confirmed precisely nothing — vacuous truth wearing the
  // word that is supposed to carry the most weight here.
  if (fields.length > 0 && !fields.some((field) => field.verdict === "verified")) {
    reasons.push("No field was established by the call.");
  }

  const score = input.completionConfidence?.score ?? null;
  if (score === null) {
    reasons.push("No completion confidence was reported.");
  } else if (score < minConfidence) {
    reasons.push(
      `Completion confidence ${score.toFixed(2)} is below the ${minConfidence.toFixed(2)} floor.`,
    );
  }

  return {
    verdict: reasons.length === 0 ? "verified" : "needs_human",
    fields,
    reasons,
    unsupportedFields: unsupported.map((f) => f.field),
    unclaimedQuestions: unclaimed,
    minConfidence,
  };
}

/**
 * The result, with every field the gate could not vouch for set to `null`.
 *
 * This is what downstream systems are allowed to read. A field that was never
 * asked comes back `null` no matter how confident the model sounded, so a
 * caller that ignores the report still cannot store an unestablished fact.
 */
export function gatedResult(report: GateReport, result: Record<string, unknown> | null): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of report.fields) {
    const trusted = field.verdict === "verified" || field.verdict === "attributed";
    out[field.field] = trusted ? (result?.[field.field] ?? null) : null;
  }
  return out;
}
