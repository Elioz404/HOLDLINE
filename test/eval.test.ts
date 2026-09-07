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
  const report = runEvaluation(400);

  it("catches every invented value in the corpus", () => {
    expect(report.hallucinated.total).toBe(80);
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

  it("is stable across runs", () => {
    expect(runEvaluation(400)).toEqual(report);
  });
});
