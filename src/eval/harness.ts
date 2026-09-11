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
  /** A schema-only check accepts any field carrying a schema-valid value. */
  readonly schemaAccepts: boolean;
  /** Ground truth: the call never established this. */
  readonly unestablished: boolean;
  /** Ground truth: the call asked and got a usable answer. */
  readonly reallyAnswered: boolean;
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
  /** Whether forced attribution by elimination was allowed for this run. */
  readonly attributeByElimination: boolean;
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
  /**
   * Cases where the bot named the topic in a statement and asked nothing.
   *
   * A live call produced one: the agent opened by naming the thing it had been
   * sent to find out, never asked, and the gate credited the field because the
   * probe words were present. Withholding is the correct outcome; anything
   * let through here is a value the call did not establish.
   */
  readonly mentionOnly: { readonly total: number; readonly caught: number; readonly rate: number };
  /**
   * Real questions in interrogative order that carry no question mark.
   *
   * The mirror of `mentionOnly`, and in tension with it: one class must not be
   * credited, the other must not be eaten. A live call produced the second.
   * `withheld` here is the error, not the catch.
   */
  readonly invertedNoMark: { readonly total: number; readonly withheld: number; readonly rate: number };
  /** Cases the bot asked directly and answered: should pass cleanly. */
  readonly straightforward: { readonly total: number; readonly passed: number; readonly rate: number };
  /**
   * Cases whose returned value is prose rather than an enumerated token.
   *
   * A live call produced one of these and the gate called it `verified`: the
   * usable-value check knew only short sentinels like `unknown`, so a refusal
   * written as a sentence sailed through. Both directions are measured, because
   * a check strict enough to catch the non-answers must not eat the real ones.
   */
  readonly prose: {
    /** Prose that reports nothing was established. Withholding is the catch. */
    readonly nonAnswer: { readonly total: number; readonly caught: number; readonly rate: number };
    /** Genuine answers written as prose. Withholding one is the error. */
    readonly answered: {
      readonly total: number;
      readonly wronglyWithheld: number;
      readonly rate: number;
    };
  };
  readonly overallAccuracy: number;
  /**
   * What a caller ends up believing, which is the number that matters to
   * whoever acts on the answer.
   *
   * `schemaOnly` is the baseline: accept every field carrying a schema-valid
   * value, which is what trusting `structured_result` amounts to. `gated` is
   * what HOLDLINE reports. `unestablished` counts answers the call never
   * actually established.
   */
  readonly reported: {
    readonly schemaOnly: { readonly accepted: number; readonly unestablished: number; readonly rate: number };
    readonly gated: { readonly accepted: number; readonly unestablished: number; readonly rate: number };
    /**
     * Answers that were genuinely asked and genuinely given, and that the gate
     * withheld anyway because it could not attribute them to a field. This is
     * the cost of the guarantee above.
     */
    readonly withheldReal: number;
  };
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
function judge(item: EvalCase, attributeByElimination: boolean): CaseResult {
  const report = runEvidenceGate({
    structuredResult: item.structuredResult,
    transcriptTurns: item.transcript,
    probes: [probeFor(item.field)],
    completionConfidence: { score: 0.9, label: "high" },
    attributeByElimination,
  });

  const field = report.fields[0]!;
  // A field is withheld when its value does not come back. `attributed` does
  // come back — it is weaker evidence, reported as such, not a withholding.
  const withheld = field.verdict !== "verified" && field.verdict !== "attributed";
  const flaggedUnsupported = field.unsupported;

  // Ground truth: a field should pass only when it was genuinely asked and
  // genuinely answered.
  const shouldPass = item.trulyAsked && item.trulyAnswered;
  const correct = shouldPass ? !withheld : withheld;

  return {
    id: item.id,
    kind: item.kind,
    field: item.field,
    schemaAccepts: item.structuredResult !== null,
    // A fact is established when it was asked *and* answered. This used to
    // read `!item.trulyAsked`, which quietly meant the headline "never
    // established" figure could only ever count values invented for questions
    // nobody asked. A question that was asked and stonewalled — the single
    // most common real outcome, and the one a live call exposed — scored as
    // established no matter what the gate did with it. The metric could not
    // see its own worst case.
    unestablished: !(item.trulyAsked && item.trulyAnswered),
    reallyAnswered: item.trulyAsked && item.trulyAnswered,
    withheld,
    flaggedUnsupported,
    correct,
  };
}

const rate = (numerator: number, denominator: number): number =>
  denominator === 0 ? 0 : numerator / denominator;

export function runEvaluation(
  size = 400,
  seed = 20260906,
  attributeByElimination = false,
): EvalReport {
  const corpus = buildCorpus(size, seed);
  const results = corpus.map((item) => judge(item, attributeByElimination));

  const hallucinatedCases = results.filter((r) => r.kind === "not_asked_value_returned");
  const paraphrasedCases = results.filter((r) => r.kind === "asked_paraphrase_answered");
  const directCases = results.filter((r) => r.kind === "asked_direct_answered");
  const proseNonAnswerCases = results.filter((r) => r.kind === "asked_prose_non_answer");
  const proseAnsweredCases = results.filter((r) => r.kind === "asked_prose_answered");
  const mentionOnlyCases = results.filter((r) => r.kind === "asked_mention_only");
  const invertedCases = results.filter((r) => r.kind === "asked_inverted_no_mark");

  const caught = hallucinatedCases.filter((r) => r.flaggedUnsupported).length;
  const falseWithheld = paraphrasedCases.filter((r) => r.withheld).length;
  const passed = directCases.filter((r) => !r.withheld).length;
  const misaccused = paraphrasedCases.filter((r) => r.flaggedUnsupported).length;

  // The question was asked in both prose classes, so `flaggedUnsupported` is
  // the wrong predicate here: neither value is invented. What separates them is
  // whether the value says anything, so withholding is the signal both ways.
  const proseCaught = proseNonAnswerCases.filter((r) => r.withheld).length;
  const proseEaten = proseAnsweredCases.filter((r) => r.withheld).length;
  const mentionCaught = mentionOnlyCases.filter((r) => r.withheld).length;
  // Asked and answered, so a withholding is an answer destroyed, not a catch.
  const invertedEaten = invertedCases.filter((r) => r.withheld).length;

  // What each approach hands to whoever acts on the answer.
  const schemaAccepted = results.filter((r) => r.schemaAccepts);
  const schemaWrong = schemaAccepted.filter((r) => r.unestablished).length;
  const gatedAccepted = results.filter((r) => !r.withheld);
  const gatedWrong = gatedAccepted.filter((r) => r.unestablished).length;

  return {
    seed,
    size: corpus.length,
    attributeByElimination,
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
    invertedNoMark: {
      total: invertedCases.length,
      withheld: invertedEaten,
      rate: rate(invertedEaten, invertedCases.length),
    },
    mentionOnly: {
      total: mentionOnlyCases.length,
      caught: mentionCaught,
      rate: rate(mentionCaught, mentionOnlyCases.length),
    },
    prose: {
      nonAnswer: {
        total: proseNonAnswerCases.length,
        caught: proseCaught,
        rate: rate(proseCaught, proseNonAnswerCases.length),
      },
      answered: {
        total: proseAnsweredCases.length,
        wronglyWithheld: proseEaten,
        rate: rate(proseEaten, proseAnsweredCases.length),
      },
    },
    overallAccuracy: rate(results.filter((r) => r.correct).length, results.length),
    reported: {
      schemaOnly: {
        accepted: schemaAccepted.length,
        unestablished: schemaWrong,
        rate: rate(schemaWrong, schemaAccepted.length),
      },
      gated: {
        accepted: gatedAccepted.length,
        unestablished: gatedWrong,
        rate: rate(gatedWrong, gatedAccepted.length),
      },
      // Only cases that genuinely were asked *and* answered count as a real
      // answer lost. A question asked with no usable reply was never an answer.
      withheldReal: results.filter((r) => r.withheld && r.reallyAnswered).length,
    },
    cases: results,
  };
}

const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;

/**
 * Both modes side by side.
 *
 * Elimination is the only lever that moves the withheld-paraphrase number on
 * this corpus, because the paraphrases were written to share no vocabulary
 * with their probes — no lexical improvement can reach them. The question that
 * matters is whether buying those answers back costs any of the guarantee, and
 * the second line is where you check.
 */
export function formatComparison(size = 400, seed = 20260906): string {
  const strict = runEvaluation(size, seed, false);
  const eliminated = runEvaluation(size, seed, true);

  return [
    `Attribution by elimination — ${size} cases, seed ${seed}`,
    "",
    `                                  strict        with elimination`,
    `  Invented values caught          ${strict.hallucinated.caught}/${strict.hallucinated.total} ${pct(strict.hallucinated.rate).padStart(7)}      ${eliminated.hallucinated.caught}/${eliminated.hallucinated.total} ${pct(eliminated.hallucinated.rate).padStart(7)}`,
    `  Answers reported                ${String(strict.reported.gated.accepted).padStart(11)}      ${String(eliminated.reported.gated.accepted).padStart(11)}`,
    `  ...never established            ${String(strict.reported.gated.unestablished).padStart(11)}      ${String(eliminated.reported.gated.unestablished).padStart(11)}`,
    `  Real answers withheld           ${String(strict.reported.withheldReal).padStart(11)}      ${String(eliminated.reported.withheldReal).padStart(11)}`,
    "",
    "  Read the second column against this corpus, not against your workflow.",
    "  Every case here probes exactly ONE field, so elimination is always",
    "  unambiguous and fires on every paraphrase. A real call asking three",
    "  questions needs two of them matched before the third can be eliminated,",
    "  so it fires far less often. This is the ceiling, not the expectation.",
    "",
    "  What the corpus does show is that buying those answers back cost nothing:",
    "  the catch rate held at 100% and no unestablished value got through.",
    "",
    "  Off by default. It assumes the agent asked only what the task told it to —",
    "  reasonable, since the task is the instruction, but not guaranteed.",
  ].join("\n");
}

export function formatReport(report: EvalReport): string {
  return [
    `Evidence Gate evaluation — ${report.size} cases, seed ${report.seed}, no calls placed`,
    "",
    `  Invented values caught         ${report.hallucinated.caught}/${report.hallucinated.total}  ${pct(report.hallucinated.rate)}`,
    `  Direct asks passed             ${report.straightforward.passed}/${report.straightforward.total}  ${pct(report.straightforward.rate)}`,
    `  Paraphrases wrongly accused    ${report.paraphrased.misaccused}/${report.paraphrased.total}  ${pct(report.paraphrased.misaccusedRate)}`,
    `  Paraphrases withheld           ${report.paraphrased.withheld}/${report.paraphrased.total}  ${pct(report.paraphrased.rate)}`,
    `  Prose non-answers caught       ${report.prose.nonAnswer.caught}/${report.prose.nonAnswer.total}  ${pct(report.prose.nonAnswer.rate)}`,
    `  Prose answers wrongly withheld ${report.prose.answered.wronglyWithheld}/${report.prose.answered.total}  ${pct(report.prose.answered.rate)}`,
    `  Mentions without a question    ${report.mentionOnly.caught}/${report.mentionOnly.total}  ${pct(report.mentionOnly.rate)}`,
    `  Questions without a mark eaten ${report.invertedNoMark.withheld}/${report.invertedNoMark.total}  ${pct(report.invertedNoMark.rate)}`,
    "",
    `  Overall accuracy               ${pct(report.overallAccuracy)}`,
    "",
    "  What a caller ends up believing:",
    `    Trusting structured_result   ${report.reported.schemaOnly.accepted} answers, ${report.reported.schemaOnly.unestablished} never established  ${pct(report.reported.schemaOnly.rate)} wrong`,
    `    Through the gate             ${report.reported.gated.accepted} answers, ${report.reported.gated.unestablished} never established  ${pct(report.reported.gated.rate)} wrong`,
    `    Real answers withheld        ${report.reported.withheldReal}`,
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
