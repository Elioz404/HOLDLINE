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
 * bot actually spoke. Four verdicts:
 *
 *   verified          the bot raised the topic and a usable value came back
 *   asked_but_unclear the bot raised the topic and the answer was not usable
 *   never_asked       no bot turn raised the topic
 *   no_transcript     there is no transcript, so nothing can be checked
 *
 * The one that matters is a field carrying a confident-looking value whose
 * topic was never spoken. That is `never_asked` with `unsupported: true`, and
 * it is the case a plain schema check cannot see.
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

function botSaidSomethingMatching(
  botText: readonly string[],
  probe: FieldProbe,
): boolean {
  return botText.some((text) =>
    probe.asks.some((ask) =>
      typeof ask === "string" ? text.includes(ask.toLowerCase()) : ask.test(text),
    ),
  );
}

function judgeField(
  probe: FieldProbe,
  result: Record<string, unknown> | null,
  botText: readonly string[],
  hasTranscript: boolean,
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
      note: "No transcript turns were returned, so it cannot be shown that this was asked.",
    };
  }

  const asked = botSaidSomethingMatching(botText, probe);

  let verdict: FieldVerdict;
  if (asked && hasValue) verdict = "verified";
  else if (asked) verdict = "asked_but_unclear";
  else verdict = "never_asked";

  const unsupported = verdict === "never_asked" && hasValue;

  const note = unsupported
    ? "A value was returned for a topic no bot turn raised. The call did not establish this."
    : verdict === "never_asked"
      ? "No bot turn raised this topic."
      : verdict === "asked_but_unclear"
        ? "The bot raised this topic but no usable answer came back."
        : "A bot turn raised this topic and a usable answer came back.";

  return { field: probe.field, required: probe.required, verdict, hasValue, unsupported, note };
}

/** Flatten the bot's spoken turns to lowercased text, oldest first. */
export function botTurnText(turns: readonly CallTranscriptTurn[]): string[] {
  return turns
    .filter((turn) => turn.speaker === "bot")
    .map((turn) => turn.text.toLowerCase());
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

  const fields = input.probes.map((probe) =>
    judgeField(probe, input.structuredResult, botText, hasTranscript),
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
    if (field.verdict === "verified") continue;
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
    out[field.field] = field.verdict === "verified" ? (result?.[field.field] ?? null) : null;
  }
  return out;
}
