import { describe, expect, it } from "vitest";
import { CalleClient } from "@call-e/calle";

import { NoDialableTargetsError, planQueue, runQueue, type QueueRequest } from "../src/engine/queue.js";
import { IdempotencyLedger } from "../src/core/idempotency.js";
import { SCENARIOS, createFakeCalle, type Scenario } from "../src/testing/fake-calle.js";
import type { FieldProbe } from "../src/evidence/types.js";

const PROBES: FieldProbe[] = [
  { field: "reached_department", required: true, asks: ["department", "through to"] },
  { field: "reference_status", required: true, asks: ["reference", "status of"] },
];

const baseRequest = (overrides: Partial<QueueRequest> = {}): QueueRequest => ({
  workflow: "status-watch",
  intent: "status-check",
  batchId: "batch-2026-09-06",
  goal: "Reach account services and confirm the status of reference 88431.",
  routingHint: "Navigate any phone menu to reach a representative.",
  targets: [{ subjectId: "vendor-1", phone: "+15550199001", label: "Vendor One" }],
  probes: PROBES,
  recipientResultSchema: {
    type: "object",
    properties: {
      reached_department: { type: "string" },
      reference_status: { type: "string" },
    },
  },
  ...overrides,
});

const clientWith = (scenario: Scenario) => {
  const fake = createFakeCalle({ scenario });
  return { fake, client: new CalleClient({ apiKey: "iams_test_key", fetch: fake.fetch }) };
};

describe("planQueue", () => {
  it("compiles a task within the API limit and derives a stable key", () => {
    const plan = planQueue(baseRequest());
    expect(plan.task.used).toBeLessThanOrEqual(255);
    expect(plan.idempotencyKey).toBe(planQueue(baseRequest()).idempotencyKey);
    expect(plan.dialable).toHaveLength(1);
  });

  it("separates undialable targets before anything is dispatched", () => {
    const plan = planQueue(
      baseRequest({
        targets: [
          { subjectId: "ok", phone: "+15550199001" },
          { subjectId: "spaces", phone: "+1 555 019 9002" },
          { subjectId: "emergency", phone: "+19110000000" },
        ],
      }),
    );

    expect(plan.dialable.map((t) => t.subjectId)).toEqual(["ok"]);
    expect(plan.rejected).toEqual([
      { subjectId: "spaces", maskedPhone: "[redacted-phone]", reason: "contains_whitespace" },
      { subjectId: "emergency", maskedPhone: "+19••••00", reason: "blocked_prefix" },
    ]);
  });

  it("drops the routing hint before a required segment when space runs out", () => {
    const plan = planQueue(baseRequest({ goal: "x".repeat(180), routingHint: "y".repeat(60) }));
    expect(plan.task.dropped).toEqual(["routing"]);
  });
});

describe("runQueue", () => {
  it("previews by default and dials nothing", async () => {
    const { fake, client } = clientWith(SCENARIOS.ivr_traversal);
    const outcome = await runQueue(baseRequest(), { client });

    expect(outcome.kind).toBe("preview");
    expect(fake.createdCount).toBe(0);
    expect(fake.idempotencyKeysSeen).toEqual([]);
  });

  it("refuses a batch with nothing dialable", async () => {
    const { client } = clientWith(SCENARIOS.ivr_traversal);
    await expect(
      runQueue(baseRequest({ targets: [{ subjectId: "bad", phone: "not-a-number" }] }), { client }),
    ).rejects.toThrow(NoDialableTargetsError);
  });

  it("dispatches once in live mode and gates the result", async () => {
    const { fake, client } = clientWith(SCENARIOS.ivr_traversal);
    const outcome = await runQueue(baseRequest({ mode: "live" }), {
      client,
      intervalMs: 1,
      timeoutMs: 2000,
    });

    expect(outcome.kind).toBe("completed");
    if (outcome.kind !== "completed") return;

    expect(fake.createdCount).toBe(1);
    expect(outcome.replayed).toBe(false);
    expect(outcome.targets[0]?.gate.verdict).toBe("verified");
    expect(outcome.targets[0]?.result).toEqual({
      reached_department: "yes",
      reference_status: "in_review",
    });
    // Nothing readable carries a raw number.
    expect(outcome.targets[0]?.maskedPhone).toBe("+15••••01");
  });

  it("withholds a field the call never asked about", async () => {
    const { client } = clientWith(SCENARIOS.never_asked);
    const outcome = await runQueue(
      baseRequest({ mode: "live", targets: [{ subjectId: "vendor-2", phone: "+15550199002" }] }),
      { client, intervalMs: 1, timeoutMs: 2000 },
    );

    expect(outcome.kind).toBe("completed");
    if (outcome.kind !== "completed") return;

    const target = outcome.targets[0]!;
    expect(target.gate.verdict).toBe("needs_human");
    expect(target.gate.unsupportedFields).toEqual(["reference_status"]);
    // The engine hands downstream a null, not the model's guess.
    expect(target.result["reference_status"]).toBeNull();
  });

  it("reports an unresolved outcome instead of retrying a late dial", async () => {
    const { fake, client } = clientWith(SCENARIOS.late_dial);
    const outcome = await runQueue(baseRequest({ mode: "live" }), {
      client,
      intervalMs: 1,
      timeoutMs: 20,
    });

    expect(outcome.kind).toBe("unresolved");
    if (outcome.kind !== "unresolved") return;

    expect(outcome.classification.class).toBe("reconcile");
    expect(outcome.callId).not.toBeNull();
    expect(outcome.classification.reuseIdempotencyKey).toBe(true);
    // Exactly one call was created. A retry here would ring a second person.
    expect(fake.createdCount).toBe(1);
  });

  it("classifies a create failure without inventing a call id", async () => {
    const { client } = clientWith(SCENARIOS.provider_unavailable);
    const outcome = await runQueue(baseRequest({ mode: "live" }), { client });

    expect(outcome.kind).toBe("unresolved");
    if (outcome.kind !== "unresolved") return;
    expect(outcome.callId).toBeNull();
    expect(outcome.classification.class).toBe("retryable");
  });

  it("fetches the existing call instead of dispatching a known intent twice", async () => {
    const { fake, client } = clientWith(SCENARIOS.ivr_traversal);
    const ledger = new IdempotencyLedger();

    const first = await runQueue(baseRequest({ mode: "live" }), { client, ledger, intervalMs: 1, timeoutMs: 2000 });
    const second = await runQueue(baseRequest({ mode: "live" }), { client, ledger, intervalMs: 1, timeoutMs: 2000 });

    expect(first.kind).toBe("completed");
    expect(second.kind).toBe("completed");
    if (second.kind !== "completed") return;

    expect(second.replayed).toBe(true);
    expect(fake.createdCount).toBe(1);
    // One dispatch reached the provider, not two.
    expect(fake.idempotencyKeysSeen).toHaveLength(1);
  });

  it("gives every target its own call, and a verdict each", async () => {
    const scenario: Scenario = {
      ...SCENARIOS.ivr_traversal,
      recipients: [
        { phone: "+15550199001", transcript: SCENARIOS.ivr_traversal.recipients[0]!.transcript,
          structuredResult: { reached_department: "yes", reference_status: "in_review" } },
        { phone: "+15550199007", transcript: SCENARIOS.never_asked.recipients[0]!.transcript,
          structuredResult: { reached_department: "yes", reference_status: "approved" } },
      ],
    };
    const { fake, client } = clientWith(scenario);

    const outcome = await runQueue(
      baseRequest({
        mode: "live",
        targets: [
          { subjectId: "vendor-1", phone: "+15550199001" },
          { subjectId: "vendor-2", phone: "+15550199007" },
        ],
      }),
      { client, intervalMs: 1, timeoutMs: 2000 },
    );

    expect(outcome.kind).toBe("completed");
    if (outcome.kind !== "completed") return;

    // Two places asked, and the verdicts differ per place.
    //
    // One call each, not one call with two recipients. A live batch showed why:
    // CALL-E returns transcript turns for a one-recipient call and none for a
    // multi-recipient one, so the gate had nothing to judge and withheld every
    // field. The batch is still one question and one authorizing record; only
    // the dispatch underneath it changed.
    expect(fake.createdCount).toBe(2);
    expect(outcome.callIds).toHaveLength(2);
    expect(new Set(outcome.callIds).size).toBe(2);
    expect(outcome.targets).toHaveLength(2);
    expect(outcome.targets[0]?.callId).not.toBe(outcome.targets[1]?.callId);
    expect(outcome.targets[0]?.gate.verdict).toBe("verified");
    expect(outcome.targets[1]?.gate.verdict).toBe("needs_human");
    expect(outcome.targets[1]?.result["reference_status"]).toBeNull();
  });
});
