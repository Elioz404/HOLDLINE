import { describe, expect, it } from "vitest";

import { buildCorpus } from "../src/eval/corpus.js";
import { runEvaluation } from "../src/eval/harness.js";
import { runEvidenceGate } from "../src/evidence/gate.js";
import type { CallTranscriptTurn, FieldProbe } from "../src/evidence/types.js";

const turn = (
  speaker: CallTranscriptTurn["speaker"],
  text: string,
): CallTranscriptTurn => ({ offset_seconds: null, speaker, text });

const probes: FieldProbe[] = [
  { field: "reached_department", required: true, asks: ["department", "through to"] },
  { field: "reference_status", required: true, asks: ["reference", "status of"] },
];

describe("unattributed verdict", () => {
  /**
   * The bot asked something real, using none of the probe's words. That is a
   * measurement problem, not evidence of invention, and the gate must not
   * conflate the two.
   */
  it("does not accuse a paraphrased question of being invented", () => {
    const report = runEvidenceGate({
      structuredResult: { reference_status: "in_review" },
      transcriptTurns: [
        turn("bot", "Where does file 88431 stand at the moment?"),
        turn("user", "Still under review."),
      ],
      probes: [probes[1]!],
      completionConfidence: { score: 0.9, label: "high" },
    });

    const field = report.fields[0]!;
    expect(field.verdict).toBe("unattributed");
    expect(field.unsupported).toBe(false);
    expect(report.unsupportedFields).toEqual([]);
    // Still withheld: an answer that cannot be attributed is not a fact.
    expect(report.verdict).toBe("needs_human");
  });

  /**
   * When every question the call asked is already claimed by another field,
   * a leftover value has nothing it could have come from.
   */
  it("still flags a value when every exchange belongs to another field", () => {
    const report = runEvidenceGate({
      structuredResult: { reached_department: "yes", reference_status: "in_review" },
      transcriptTurns: [
        turn("bot", "Am I through to the account services department?"),
        turn("user", "Yes."),
        turn("bot", "Thank you for your time. Goodbye."),
      ],
      probes,
      completionConfidence: { score: 0.9, label: "high" },
    });

    expect(report.unsupportedFields).toEqual(["reference_status"]);
    expect(report.fields[1]?.verdict).toBe("never_asked");
  });

  it("does not count a bot question nobody answered as an exchange", () => {
    const report = runEvidenceGate({
      structuredResult: { reference_status: "in_review" },
      transcriptTurns: [
        turn("bot", "Where does file 88431 stand?"),
        turn("bot", "Hello? I will try again later."),
      ],
      probes: [probes[1]!],
      completionConfidence: { score: 0.9, label: "high" },
    });

    // No answer came back, so there is no exchange to attribute anything to.
    expect(report.fields[0]?.verdict).toBe("never_asked");
    expect(report.fields[0]?.unsupported).toBe(true);
  });
});

describe("evaluation corpus", () => {
  it("is deterministic for a given seed", () => {
    expect(buildCorpus(50, 7)).toEqual(buildCorpus(50, 7));
  });

  it("differs across seeds", () => {
    expect(buildCorpus(50, 7)).not.toEqual(buildCorpus(50, 8));
  });

  it("labels every case with ground truth", () => {
    for (const item of buildCorpus(50)) {
      expect(typeof item.trulyAsked).toBe("boolean");
      expect(item.transcript.length).toBeGreaterThan(0);
    }
  });
});

describe("evaluation harness", () => {
  it("does not eat a question that arrived without its mark", () => {
    // A live call produced one: the agent opened a clause with an inversion
    // and the turn was truncated before the mark. Measured before the signal
    // was added, the gate withheld 44 of 44 of these — every one a real answer
    // thrown away.
    const report = runEvaluation(400, 20260906);
    expect(report.invertedNoMark.total).toBeGreaterThan(0);
    expect(report.invertedNoMark.withheld).toBe(0);
  });

  it("still refuses a statement of purpose, which that signal could have reopened", () => {
    // The class this one sits against. Anchoring the inversion to a clause
    // boundary is the whole reason both can hold at once: if this number
    // moves, the result above was bought by undoing an earlier fix.
    const report = runEvaluation(400, 20260906);
    expect(report.mentionOnly.caught).toBe(report.mentionOnly.total);
  });

  it("still credits nothing the call never established", () => {
    const report = runEvaluation(400, 20260906);
    expect(report.reported.gated.unestablished).toBe(0);
  });

  const report = runEvaluation(400);

  it("catches every invented value in the corpus", () => {
    // Counted from the corpus rather than hardcoded. A magic number here had
    // to be edited the moment the corpus grew a class, which is exactly when
    // a test should be holding still and telling the truth instead.
    const invented = buildCorpus(400).filter((item) => item.kind === "not_asked_value_returned").length;
    expect(report.hallucinated.total).toBe(invented);
    expect(report.hallucinated.rate).toBe(1);
  });

  it("passes every directly asked and answered case", () => {
    expect(report.straightforward.rate).toBe(1);
  });

  it("never accuses a paraphrase of being invented", () => {
    // The measurement that justified adding the `unattributed` verdict.
    expect(report.paraphrased.misaccused).toBe(0);
  });

  it("reports the withholding cost rather than hiding it", () => {
    // Honest cost: a paraphrase is still withheld. If this ever reads 0 without
    // a change to topic detection, the corpus has stopped being adversarial.
    expect(report.paraphrased.rate).toBe(1);
  });

  it("catches a non-answer written as prose, not just as a sentinel token", () => {
    // The defect a live call found: the usable-value check knew `unknown` and
    // `n/a` and nothing longer, so a refusal written as a sentence came back
    // `verified`. Counted from the corpus for the reason given above.
    const nonAnswers = buildCorpus(400).filter((item) => item.kind === "asked_prose_non_answer").length;
    expect(report.prose.nonAnswer.total).toBe(nonAnswers);
    expect(report.prose.nonAnswer.rate).toBe(1);
  });

  it("does not eat a genuine answer for being written as prose", () => {
    // The other direction, and the reason the fix is a measurement rather than
    // a tightened heuristic. A check strict enough to catch the line above must
    // still let a real answer through.
    expect(report.prose.answered.wronglyWithheld).toBe(0);
  });

  it("does not credit a field the bot only mentioned", () => {
    // Found by a live call, not by this suite. The agent introduced itself as
    // "an automated assistant checking the National Weather Service Seattle
    // forecast for today", asked nothing, and the gate marked the field
    // verified because the probe words were sitting in that sentence. Counted
    // from the corpus for the reason given above.
    const mentions = buildCorpus(400).filter((item) => item.kind === "asked_mention_only").length;
    expect(report.mentionOnly.total).toBe(mentions);
    expect(report.mentionOnly.rate).toBe(1);
  });

  it("still passes a genuine ask that carries no question mark", () => {
    // The cost side of the fix above, and the reason it is a request test
    // rather than a search for "?". "I wanted to check whether you accept new
    // patients" asks something and must keep passing.
    expect(report.straightforward.rate).toBe(1);
  });

  it("is stable across runs", () => {
    expect(runEvaluation(400)).toEqual(report);
  });
});
