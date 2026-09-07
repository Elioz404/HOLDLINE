import { describe, expect, it } from "vitest";

import { DAY, FactLedger, HOUR, type TtlPolicy } from "../src/ledger/facts.js";
import { RouteCache, observeRoute } from "../src/ledger/routes.js";
import { runEvidenceGate } from "../src/evidence/gate.js";
import type { CallTranscriptTurn, FieldProbe } from "../src/evidence/types.js";

const turn = (
  speaker: CallTranscriptTurn["speaker"],
  text: string,
  offset: number | null = null,
): CallTranscriptTurn => ({ offset_seconds: offset, speaker, text });

const probes: FieldProbe[] = [
  { field: "accepts_new_patients", required: true, asks: ["new patients"] },
  { field: "reference_status", required: true, asks: ["reference"] },
];

const gateFor = (result: Record<string, unknown> | null, turns: CallTranscriptTurn[]) =>
  runEvidenceGate({
    structuredResult: result,
    transcriptTurns: turns,
    probes,
    completionConfidence: { score: 0.9, label: "high" },
  });

const ANSWERED: CallTranscriptTurn[] = [
  turn("bot", "Are you accepting new patients?"),
  turn("user", "Yes, we are."),
  turn("bot", "And can you confirm the status of reference 88431?"),
  turn("user", "Still in review."),
];

describe("FactLedger", () => {
  const policy: TtlPolicy = {
    perField: { accepts_new_patients: 30 * DAY, reference_status: 0 },
    fallbackMs: 0,
  };

  it("stores only the fields the gate verified", () => {
    let now = 1_000_000;
    const ledger = new FactLedger(policy, () => now);

    // The reference status was never asked; only the first field is verified.
    const turns = [turn("bot", "Are you accepting new patients?"), turn("user", "Yes.")];
    const result = { accepts_new_patients: "yes", reference_status: "in_review" };
    const written = ledger.record({
      subjectId: "clinic-7",
      callId: "call_1",
      gate: gateFor(result, turns),
      result,
      confidence: 0.9,
    });

    expect(written.map((f) => f.field)).toEqual(["accepts_new_patients"]);
    expect(ledger.lookup("clinic-7", "reference_status").freshness).toBe("miss");
    now += 1;
  });

  it("cites the sentence that established the fact", () => {
    const ledger = new FactLedger(policy, () => 1_000_000);
    const result = { accepts_new_patients: "yes", reference_status: "in_review" };
    const [fact] = ledger.record({
      subjectId: "clinic-7",
      callId: "call_1",
      gate: gateFor(result, ANSWERED),
      result,
      confidence: 0.9,
    });

    expect(fact?.supportingTurn).toBe("Are you accepting new patients?");
    expect(fact?.callId).toBe("call_1");
  });

  it("serves a fact fresh until its TTL and stale after", () => {
    let now = 0;
    const ledger = new FactLedger(policy, () => now);
    const result = { accepts_new_patients: "yes" };
    ledger.record({
      subjectId: "clinic-7",
      callId: "call_1",
      gate: gateFor(result, ANSWERED),
      result,
      confidence: 0.9,
    });

    now = 29 * DAY;
    expect(ledger.lookup("clinic-7", "accepts_new_patients").freshness).toBe("fresh");

    now = 31 * DAY;
    expect(ledger.lookup("clinic-7", "accepts_new_patients").freshness).toBe("stale");
  });

  it("treats a fact with no TTL policy as immediately stale", () => {
    // Forgetting to classify a field must cause a call, never a reused answer.
    let now = 0;
    const ledger = new FactLedger({ perField: {} }, () => now);
    const result = { accepts_new_patients: "yes" };
    ledger.record({
      subjectId: "clinic-7",
      callId: "call_1",
      gate: gateFor(result, ANSWERED),
      result,
      confidence: 0.9,
    });

    now = 1;
    expect(ledger.lookup("clinic-7", "accepts_new_patients").freshness).toBe("stale");
  });

  it("splits targets into answered and still-worth-calling", () => {
    const ledger = new FactLedger(policy, () => 0);
    const result = { accepts_new_patients: "yes" };
    ledger.record({
      subjectId: "clinic-7",
      callId: "call_1",
      gate: gateFor(result, ANSWERED),
      result,
      confidence: 0.9,
    });

    const { answered, toCall } = ledger.partition(
      [{ subjectId: "clinic-7" }, { subjectId: "clinic-8" }],
      "accepts_new_patients",
    );

    expect(answered).toHaveLength(1);
    expect(toCall.map((t) => t.subjectId)).toEqual(["clinic-8"]);
    // One call not placed.
    expect(ledger.stats().servedFresh).toBe(1);
  });

  it("counts a call whose status is volatile as always needing a fresh call", () => {
    const ledger = new FactLedger(policy, () => 0);
    const result = { reference_status: "in_review" };
    ledger.record({
      subjectId: "case-1",
      callId: "call_1",
      gate: gateFor(result, ANSWERED),
      result,
      confidence: 0.9,
    });
    // TTL is 0 for this field: it was true when the call ended and not after.
    expect(ledger.lookup("case-1", "reference_status").freshness).toBe("stale");
  });
});

describe("route cache", () => {
  const MENU: CallTranscriptTurn[] = [
    turn("unknown", "Please listen carefully as our menu options have changed.", 3),
    turn("unknown", "For billing press 1. For account services press 2.", 10),
    turn("bot", "Selecting account services.", 17),
    turn("unknown", "For new accounts press 2. For existing customers press 1.", 22),
    turn("bot", "Selecting existing customers.", 29),
    turn("unknown", "All of our representatives are currently busy. Please hold.", 34),
    turn("user", "Account services, this is Dana.", 208),
    turn("bot", "Hello, I am an automated assistant.", 212),
  ];

  it("reads the menu path and the moment a person answered", () => {
    const observation = observeRoute({ subjectId: "payer-1", callId: "call_1", turns: MENU });

    expect(observation).not.toBeNull();
    expect(observation?.steps).toEqual([
      "Selecting account services.",
      "Selecting existing customers.",
    ]);
    expect(observation?.reachedHumanAtSeconds).toBe(208);
    // Bot turns after the human answered are conversation, not routing.
    expect(observation?.steps).not.toContain("Hello, I am an automated assistant.");
  });

  it("returns nothing when a human answers directly", () => {
    // No menu means no route. Caching an invented one would mislead the next
    // caller into narrating steps that do not exist.
    const observation = observeRoute({
      subjectId: "small-shop",
      callId: "call_2",
      turns: [turn("user", "Hello, shop speaking.", 2), turn("bot", "Hello.", 4)],
    });
    expect(observation).toBeNull();
  });

  it("turns a cached route into a task hint and counts repeat sightings", () => {
    const cache = new RouteCache();
    const observation = observeRoute({ subjectId: "payer-1", callId: "call_1", turns: MENU })!;

    cache.record(observation);
    expect(cache.hintFor("payer-1")).toBe(
      "Last time the menu path was: Selecting account services. then Selecting existing customers.",
    );

    const second = cache.record({ ...observation, callId: "call_2" });
    expect(second.timesSeen).toBe(2);
    expect(cache.size).toBe(1);
  });

  it("has no hint for a place it has never called", () => {
    expect(new RouteCache().hintFor("unseen")).toBeNull();
  });

  it("totals the hold time the machine absorbed", () => {
    const cache = new RouteCache();
    cache.record(observeRoute({ subjectId: "payer-1", callId: "call_1", turns: MENU })!);
    // 208 seconds a person did not spend listening to hold music.
    expect(cache.totalHoldSeconds()).toBe(208);
  });

  it("survives a transcript with no timing information", () => {
    const cache = new RouteCache();
    const untimed = MENU.map((t) => ({ ...t, offset_seconds: null }));
    cache.record(observeRoute({ subjectId: "payer-2", callId: "call_3", turns: untimed })!);
    expect(cache.get("payer-2")?.reachedHumanAtSeconds).toBeNull();
    expect(cache.totalHoldSeconds()).toBe(0);
  });
});

describe("HOUR constant", () => {
  it("is an hour", () => {
    expect(HOUR).toBe(3_600_000);
  });
});
