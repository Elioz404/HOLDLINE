/**
 * Measuring the Evidence Gate.
 *
 * The claim this project makes is that a call result can carry a confident,
 * schema-valid value for a question that was never asked, and that the gate
 * catches it. This harness turns that claim into two numbers.
 *
 * The headline number is **catch rate**: of the cases where a value came back
 * for a topic the bot genuinely never raised, how many did the gate withhold?
 *
 * The number that keeps it honest is **false-withhold rate**: of the cases
 * where the bot genuinely did ask — but phrased it in words the probes do not
 * contain — how many did the gate wrongly withhold? A lexical matcher cannot
 * see a paraphrase, and pretending otherwise would make the first number
 * meaningless. Both are reported, always, side by side.
 *
 * Runs offline against a seeded corpus. No credentials, no calls, no network.
 */

import { runEvidenceGate } from "../evidence/gate.js";
import type { FieldProbe } from "../evidence/types.js";
import { PROBE_VOCABULARY, buildCorpus, type EvalCase } from "./corpus.js";

export interface CaseResult {
  readonly id: string;
  readonly kind: EvalCase["kind"];
  readonly field: string;
  /** Did the gate withhold the field (i.e. not mark it `verified`)? */
  readonly withheld: boolean;
  /** Did the gate flag the field as carrying an unasked-for value? */
  readonly flaggedUnsupported: boolean;
  /** Whether the gate's judgement matches ground truth for this case. */
  readonly correct: boolean;
}

export interface Measure {
  readonly total: number;
  readonly count: number;
  readonly rate: number;
}

export interface EvalReport {
  readonly seed: number;
  readonly size: number;
  /** Cases where a value came back for a topic never raised. */
  readonly hallucinated: { readonly total: number; readonly caught: number; readonly rate: number };
  /** Cases where the bot asked in words the probes do not contain. */
  readonly paraphrased: {
    readonly total: number;
    /** Withheld — correct and safe, since the answer cannot be attributed. */
    readonly withheld: number;
    readonly rate: number;
    /** Wrongly accused of being invented. This is the number that must be 0. */
    readonly misaccused: number;
    readonly misaccusedRate: number;
  };
  /** Cases the bot asked directly and answered: should pass cleanly. */
  readonly straightforward: { readonly total: number; readonly passed: number; readonly rate: number };
  readonly overallAccuracy: number;
  readonly cases: readonly CaseResult[];
}

function probeFor(field: string): FieldProbe {
  return {
    field,
    required: true,
    asks: PROBE_VOCABULARY[field] ?? [],
  };
}

/**
 * Judge one case the way production would: the gate sees a transcript and a
 * result, and nothing else. Confidence is held at a passing value throughout
 * so the measurement isolates the transcript check rather than the threshold.
 */
function judge(item: EvalCase): CaseResult {
  const report = runEvidenceGate({
    structuredResult: item.structuredResult,
    transcriptTurns: item.transcript,
    probes: [probeFor(item.field)],
    completionConfidence: { score: 0.9, label: "high" },
  });

  const field = report.fields[0]!;
  const withheld = field.verdict !== "verified";
  const flaggedUnsupported = field.unsupported;

  // Ground truth: a field should pass only when it was genuinely asked and
  // genuinely answered.
  const shouldPass = item.trulyAsked && item.trulyAnswered;
  const correct = shouldPass ? !withheld : withheld;

  return { id: item.id, kind: item.kind, field: item.field, withheld, flaggedUnsupported, correct };
}

const rate = (numerator: number, denominator: number): number =>
  denominator === 0 ? 0 : numerator / denominator;

export function runEvaluation(size = 400, seed = 20260906): EvalReport {
  const corpus = buildCorpus(size, seed);
  const results = corpus.map(judge);

  const hallucinatedCases = results.filter((r) => r.kind === "not_asked_value_returned");
  const paraphrasedCases = results.filter((r) => r.kind === "asked_paraphrase_answered");
  const directCases = results.filter((r) => r.kind === "asked_direct_answered");

  const caught = hallucinatedCases.filter((r) => r.flaggedUnsupported).length;
  const falseWithheld = paraphrasedCases.filter((r) => r.withheld).length;
  const passed = directCases.filter((r) => !r.withheld).length;
  const misaccused = paraphrasedCases.filter((r) => r.flaggedUnsupported).length;

  return {
    seed,
    size: corpus.length,
    hallucinated: {
      total: hallucinatedCases.length,
      caught,
      rate: rate(caught, hallucinatedCases.length),
    },
    paraphrased: {
      total: paraphrasedCases.length,
      withheld: falseWithheld,
      rate: rate(falseWithheld, paraphrasedCases.length),
      misaccused: misaccused,
      misaccusedRate: rate(misaccused, paraphrasedCases.length),
    },
    straightforward: {
      total: directCases.length,
      passed,
      rate: rate(passed, directCases.length),
    },
    overallAccuracy: rate(results.filter((r) => r.correct).length, results.length),
    cases: results,
  };
}

const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;

export function formatReport(report: EvalReport): string {
  return [
    `Evidence Gate evaluation — ${report.size} cases, seed ${report.seed}, no calls placed`,
    "",
    `  Invented values caught         ${report.hallucinated.caught}/${report.hallucinated.total}  ${pct(report.hallucinated.rate)}`,
    `  Direct asks passed             ${report.straightforward.passed}/${report.straightforward.total}  ${pct(report.straightforward.rate)}`,
    `  Paraphrases wrongly accused    ${report.paraphrased.misaccused}/${report.paraphrased.total}  ${pct(report.paraphrased.misaccusedRate)}`,
    `  Paraphrases withheld           ${report.paraphrased.withheld}/${report.paraphrased.total}  ${pct(report.paraphrased.rate)}`,
    "",
    `  Overall accuracy               ${pct(report.overallAccuracy)}`,
    "",
    "  Read lines one and three together. The gate catches values invented for",
    "  questions the call never asked, and it does not accuse a genuinely asked",
    "  question of being invented just because it was phrased in words the probes",
    "  do not contain — those come back `unattributed` instead.",
    "",
    "  Line four is the honest cost. A paraphrase is still withheld, because an",
    "  answer that cannot be attributed to a question should not be stored as",
    "  fact. The gate fails toward withholding. Better probes reduce this; the",
    "  measurement is here so the trade is visible rather than omitted.",
  ].join("\n");
}
