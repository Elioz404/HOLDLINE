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
 * The gate never repairs a value. It reports, and it withholds.
 */

import type { CallTranscriptTurn, FieldVerdict, GateInput, GateReport, FieldReport, FieldProbe } from "./types.js";

/** Values that are present in the JSON but mean "no answer". */
const DEFAULT_UNKNOWN_VALUES = ["", "unknown", "unclear", "n/a", "na", "none", "null"];

/** Below this, a call is not allowed to speak for itself. */
export const DEFAULT_MIN_CONFIDENCE = 0.7;

function isUsableValue(value: unknown, unknownValues: readonly string[]): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") {
    return !unknownValues.includes(value.trim().toLowerCase());
  }
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/** The first bot turn matching this field's probes, or null. */
function findSupportingTurn(
  botTurns: readonly string[],
  probe: FieldProbe,
): string | null {
  const hit = botTurns.find((text) =>
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
