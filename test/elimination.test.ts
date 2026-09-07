import { describe, expect, it } from "vitest";

import { gatedResult, runEvidenceGate } from "../src/evidence/gate.js";
import { runEvaluation } from "../src/eval/harness.js";
import type { CallTranscriptTurn, FieldProbe } from "../src/evidence/types.js";

const turn = (
  speaker: CallTranscriptTurn["speaker"],
  text: string,
): CallTranscriptTurn => ({ offset_seconds: null, speaker, text });

const bed: FieldProbe = { field: "bed_available", required: true, asks: ["a bed free", "bed available"] };
const level: FieldProbe = { field: "nursing_level", required: true, asks: ["level of nursing", "level of care"] };

const confident = { score: 0.9, label: "high" };

describe("attribution by elimination", () => {
  it("is off unless asked for", () => {
    const report = runEvidenceGate({
      structuredResult: { bed_available: "yes" },
      transcriptTurns: [turn("bot", "Could you take someone this week?"), turn("user", "Yes.")],
      probes: [bed],
      completionConfidence: confident,
    });

    expect(report.fields[0]?.verdict).toBe("unattributed");
    expect(gatedResult(report, { bed_available: "yes" })["bed_available"]).toBeNull();
  });

  it("attributes when exactly one question and one field are left over", () => {
    // A real question, phrased in words no probe contains. There is nothing
    // else it could have been about.
    const result = { bed_available: "yes" };
    const report = runEvidenceGate({
      structuredResult: result,
      transcriptTurns: [turn("bot", "Could you take someone this week?"), turn("user", "Yes, we could.")],
      probes: [bed],
      completionConfidence: confident,
      attributeByElimination: true,
    });

    const field = report.fields[0]!;
    expect(field.verdict).toBe("attributed");
    expect(field.unsupported).toBe(false);
    expect(field.supportingTurn).toBe("Could you take someone this week?");
    expect(field.note).toContain("can only have come from it");
    expect(gatedResult(report, result)["bed_available"]).toBe("yes");
  });

  it("refuses when the attribution would be a guess", () => {
    // Two unmatched fields, two unclaimed questions: which answer belongs to
    // which is exactly the guess this module exists to refuse.
    const result = { bed_available: "yes", nursing_level: "nursing" };
    const report = runEvidenceGate({
      structuredResult: result,
      transcriptTurns: [
        turn("bot", "Could you take someone this week?"),
        turn("user", "Yes."),
        turn("bot", "And how much support can your staff give?"),
        turn("user", "Quite a lot."),
      ],
      probes: [bed, level],
      completionConfidence: confident,
      attributeByElimination: true,
    });

    expect(report.fields.map((f) => f.verdict)).toEqual(["unattributed", "unattributed"]);
    expect(report.verdict).toBe("needs_human");
  });

  it("still flags an invented value when no question went unclaimed", () => {
    // The guarantee has to survive the feature. One question, matched by the
    // first field; the second field has nothing to have come from.
    const result = { bed_available: "yes", nursing_level: "nursing" };
    const report = runEvidenceGate({
      structuredResult: result,
      transcriptTurns: [
        turn("bot", "Do you have a bed free this week?"),
        turn("user", "We do."),
        turn("bot", "Thank you, goodbye."),
      ],
      probes: [bed, level],
      completionConfidence: confident,
      attributeByElimination: true,
    });

    expect(report.fields[0]?.verdict).toBe("verified");
    expect(report.fields[1]?.verdict).toBe("never_asked");
    expect(report.unsupportedFields).toEqual(["nursing_level"]);
    expect(gatedResult(report, result)["nursing_level"]).toBeNull();
  });

  it("reports the questions no probe claimed, so probes can be fixed", () => {
    const report = runEvidenceGate({
      structuredResult: { bed_available: "yes" },
      transcriptTurns: [
        turn("bot", "Could you take someone this week?"),
        turn("user", "Yes."),
      ],
      probes: [bed],
      completionConfidence: confident,
    });

    expect(report.unclaimedQuestions).toEqual(["Could you take someone this week?"]);
  });

  it("does not count a question nobody answered as available for elimination", () => {
    const report = runEvidenceGate({
      structuredResult: { bed_available: "yes" },
      transcriptTurns: [
        turn("bot", "Could you take someone this week?"),
        turn("bot", "Hello? I will try again later."),
      ],
      probes: [bed],
      completionConfidence: confident,
      attributeByElimination: true,
    });

    expect(report.fields[0]?.verdict).toBe("never_asked");
    expect(report.fields[0]?.unsupported).toBe(true);
  });
});

describe("what elimination costs, measured", () => {
  const strict = runEvaluation(400, 20260906, false);
  const eliminated = runEvaluation(400, 20260906, true);

  it("recovers the withheld answers", () => {
    expect(strict.reported.withheldReal).toBe(80);
    expect(eliminated.reported.withheldReal).toBe(0);
    expect(eliminated.reported.gated.accepted).toBeGreaterThan(strict.reported.gated.accepted);
  });

  it("buys them without letting an unestablished value through", () => {
    // The whole point. If this ever fails, the feature has to go.
    expect(eliminated.reported.gated.unestablished).toBe(0);
    expect(eliminated.hallucinated.rate).toBe(1);
  });

  it("stays deterministic", () => {
    expect(runEvaluation(400, 20260906, true)).toEqual(eliminated);
  });
});
