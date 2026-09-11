import { describe, expect, it } from "vitest";
import { gatedResult, runEvidenceGate } from "../src/evidence/gate.js";
import type { CallTranscriptTurn, FieldProbe } from "../src/evidence/types.js";

const turn = (speaker: CallTranscriptTurn["speaker"], text: string, at: number | null = null): CallTranscriptTurn => ({
  offset_seconds: at,
  speaker,
  text,
});

const probes: FieldProbe[] = [
  {
    field: "can_hear_clearly",
    required: true,
    asks: ["hear me", "hear clearly", /can you hear/],
  },
  {
    field: "address_correct",
    required: true,
    asks: ["address", "street", "mailing"],
  },
];

const confident = { score: 0.92, label: "high" };

describe("Evidence Gate", () => {
  it("says once that the agent asked nothing, rather than blaming each field", () => {
    // Both live calls placed against real phone trees came back this shape: the
    // agent navigated a menu and answered the other party's questions without
    // ever putting one of its own. Reported field by field it reads as a
    // judgement on the place called; the call is what failed.
    const report = runEvidenceGate({
      structuredResult: { can_hear_clearly: "yes", address_correct: "yes" },
      transcriptTurns: [
        turn("bot", "Hi.", 0),
        turn("user", "Press 1 for sales. Press 2 for support.", 12),
        turn("bot", "Okay.", 14),
      ],
      probes,
      completionConfidence: confident,
    });

    expect(report.reasons).toContain(
      "The agent asked no questions on this call, so nothing could be established.",
    );
    expect(report.fields.every((field) => field.verdict === "never_asked")).toBe(true);
  });

  it("does not claim silence when the agent did ask", () => {
    const report = runEvidenceGate({
      structuredResult: { can_hear_clearly: "yes" },
      transcriptTurns: [
        turn("bot", "Can you hear me clearly?", 3),
        turn("user", "Yes, loud and clear.", 5),
      ],
      probes: [probes[0]!],
      completionConfidence: confident,
    });

    expect(report.reasons.join(" ")).not.toContain("asked no questions");
  });

  it("verifies a field the bot actually asked about", () => {
    const report = runEvidenceGate({
      structuredResult: { can_hear_clearly: "yes", address_correct: "yes" },
      transcriptTurns: [
        turn("bot", "Hi, this is an automated assistant. Can you hear me clearly?", 2),
        turn("user", "Yes, I can hear you.", 5),
        turn("bot", "Thank you. Is your mailing address still 12 Oak Street?", 8),
        turn("user", "That's right.", 12),
      ],
      probes,
      completionConfidence: confident,
    });

    expect(report.verdict).toBe("verified");
    expect(report.reasons).toEqual([]);
    expect(report.fields.map((f) => f.verdict)).toEqual(["verified", "verified"]);
  });

  /**
   * This is CALL-E issue #316, reproduced.
   *
   * The bot ran the hearing check, then moved on without ever raising the
   * address. The result still came back populated. A schema check passes this
   * — the value is a valid enum member and the confidence is high.
   */
  it("catches a value returned for a question that was never asked", () => {
    const report = runEvidenceGate({
      structuredResult: { can_hear_clearly: "yes", address_correct: "unclear" },
      transcriptTurns: [
        turn("bot", "Can you hear me clearly?", 2),
        turn("user", "Yes.", 4),
        turn("bot", "Great, thank you for your time. Goodbye.", 6),
      ],
      probes,
      completionConfidence: confident,
    });

    const address = report.fields.find((f) => f.field === "address_correct");
    expect(address?.verdict).toBe("never_asked");
    expect(report.verdict).toBe("needs_human");
    expect(report.reasons).toContain("Required field `address_correct`: never_asked.");
  });

  it("flags a confident value on a topic the call never went near as unsupported", () => {
    // The dangerous shape: not "unclear" but a definite answer, invented.
    const report = runEvidenceGate({
      structuredResult: { can_hear_clearly: "yes", address_correct: "yes" },
      transcriptTurns: [
        turn("bot", "Can you hear me clearly?", 2),
        turn("user", "Yes.", 4),
      ],
      probes,
      completionConfidence: confident,
    });

    expect(report.unsupportedFields).toEqual(["address_correct"]);
    expect(report.reasons).toContain("`address_correct` carries a value the call never asked about.");
    expect(report.verdict).toBe("needs_human");
  });

  it("separates 'asked and unclear' from 'never asked'", () => {
    const report = runEvidenceGate({
      structuredResult: { can_hear_clearly: "yes", address_correct: "unclear" },
      transcriptTurns: [
        turn("bot", "Can you hear me clearly?"),
        turn("user", "Yes."),
        turn("bot", "Is your address still on file?"),
        turn("user", "I'd rather not say."),
      ],
      probes,
      completionConfidence: confident,
    });

    const address = report.fields.find((f) => f.field === "address_correct");
    expect(address?.verdict).toBe("asked_but_unclear");
    expect(address?.unsupported).toBe(false);
  });

  it("fails closed when there is no transcript at all", () => {
    const report = runEvidenceGate({
      structuredResult: { can_hear_clearly: "yes", address_correct: "yes" },
      transcriptTurns: [],
      probes,
      completionConfidence: confident,
    });

    expect(report.verdict).toBe("needs_human");
    expect(report.fields.every((f) => f.verdict === "no_transcript")).toBe(true);
  });

  it("does not credit the user's own words as the bot having asked", () => {
    // The caller volunteering an address is not the agent verifying it.
    const report = runEvidenceGate({
      structuredResult: { can_hear_clearly: "yes", address_correct: "yes" },
      transcriptTurns: [
        turn("bot", "Can you hear me clearly?"),
        turn("user", "Yes, and my address is 12 Oak Street if you need it."),
      ],
      probes,
      completionConfidence: confident,
    });

    expect(report.fields.find((f) => f.field === "address_correct")?.verdict).toBe("never_asked");
  });

  it("withholds a verified call when confidence is below the floor", () => {
    const report = runEvidenceGate({
      structuredResult: { can_hear_clearly: "yes", address_correct: "yes" },
      transcriptTurns: [
        turn("bot", "Can you hear me clearly?"),
        turn("user", "Yes."),
        turn("bot", "Is your mailing address correct?"),
        turn("user", "Yes."),
      ],
      probes,
      completionConfidence: { score: 0.41, label: "low" },
    });

    expect(report.verdict).toBe("needs_human");
    expect(report.reasons.some((r) => r.includes("below the 0.70 floor"))).toBe(true);
  });

  it("treats a missing confidence as a reason to withhold", () => {
    const report = runEvidenceGate({
      structuredResult: { can_hear_clearly: "yes", address_correct: "yes" },
      transcriptTurns: [
        turn("bot", "Can you hear me clearly?"),
        turn("bot", "Is your mailing address correct?"),
      ],
      probes,
      completionConfidence: null,
    });

    expect(report.reasons).toContain("No completion confidence was reported.");
  });

  it("treats a null structured result as no values, not as a crash", () => {
    const report = runEvidenceGate({
      structuredResult: null,
      transcriptTurns: [turn("bot", "Can you hear me clearly?")],
      probes,
      completionConfidence: confident,
    });

    expect(report.fields.every((f) => !f.hasValue)).toBe(true);
    expect(report.verdict).toBe("needs_human");
  });
});

describe("gatedResult", () => {
  it("nulls every field the gate could not vouch for", () => {
    const structuredResult = { can_hear_clearly: "yes", address_correct: "yes" };
    const report = runEvidenceGate({
      structuredResult,
      transcriptTurns: [turn("bot", "Can you hear me clearly?"), turn("user", "Yes.")],
      probes,
      completionConfidence: confident,
    });

    // A caller that ignores the report still cannot store the invented field.
    expect(gatedResult(report, structuredResult)).toEqual({
      can_hear_clearly: "yes",
      address_correct: null,
    });
  });
});
