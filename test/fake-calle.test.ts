import { describe, expect, it } from "vitest";
import { CalleClient, CalleAPIError } from "@call-e/calle";

import { SCENARIOS, createFakeCalle } from "../src/testing/fake-calle.js";
import { runEvidenceGate } from "../src/evidence/gate.js";
import type { CallTranscriptTurn, FieldProbe } from "../src/evidence/types.js";
import { classifyFailure } from "../src/core/outcome.js";

/**
 * These tests drive the real `CalleClient` from `@call-e/calle`. Only the
 * network is replaced. If the SDK's wire contract changes, these fail — which
 * is the point: the fake is only useful while it stays faithful.
 */
const clientFor = (fake: ReturnType<typeof createFakeCalle>) =>
  new CalleClient({ apiKey: "iams_test_not_a_real_key", fetch: fake.fetch });

const turnsOf = (call: { recipients: { attempts: { transcriptTurns: unknown[] }[] }[] }): CallTranscriptTurn[] =>
  call.recipients.flatMap((r) => r.attempts.flatMap((a) => a.transcriptTurns as CallTranscriptTurn[]));

const PROBES: FieldProbe[] = [
  { field: "reached_department", required: true, asks: ["department", "through to"] },
  { field: "reference_status", required: true, asks: ["reference", "status of"] },
];

describe("fake transport against the real SDK", () => {
  it("creates a call and reaches a terminal state through the SDK", async () => {
    const fake = createFakeCalle({ scenario: SCENARIOS.ivr_traversal });
    const call = await clientFor(fake).calls.createAndWait(
      { task: "Reach account services and confirm the status of reference 88431." },
      { idempotencyKey: "hl1_test", intervalMs: 1, timeoutMs: 2000 },
    );

    expect(call.status).toBe("completed");
    expect(call.taskCompleted).toBe(true);
    expect(call.completionConfidence?.score).toBe(0.88);
    // The SDK camelCases the snake_case wire body. If this passes, the fake's
    // wire format is faithful.
    expect(call.structuredResult).toEqual({
      reached_department: "yes",
      reference_status: "in_review",
    });
    expect(turnsOf(call).length).toBeGreaterThan(0);
  });

  it("surfaces menu navigation in the transcript", async () => {
    const fake = createFakeCalle({ scenario: SCENARIOS.ivr_traversal });
    const call = await clientFor(fake).calls.createAndWait(
      { task: "Reach account services." },
      { intervalMs: 1, timeoutMs: 2000 },
    );

    const spoken = turnsOf(call).map((t) => t.text.toLowerCase());
    expect(spoken.some((t) => t.includes("press 1"))).toBe(true);
    expect(spoken.some((t) => t.includes("please hold"))).toBe(true);
  });

  it("passes the Evidence Gate on the traversal scenario", async () => {
    const fake = createFakeCalle({ scenario: SCENARIOS.ivr_traversal });
    const call = await clientFor(fake).calls.createAndWait(
      { task: "Reach account services and confirm the status of reference 88431." },
      { intervalMs: 1, timeoutMs: 2000 },
    );

    const report = runEvidenceGate({
      structuredResult: call.structuredResult,
      transcriptTurns: turnsOf(call),
      probes: PROBES,
      completionConfidence: call.completionConfidence,
    });

    expect(report.verdict).toBe("verified");
  });

  /**
   * The scenario that justifies the whole project: the platform returns a
   * confident, schema-valid answer for a question the bot never asked.
   */
  it("fails the Evidence Gate when the bot skipped the question", async () => {
    const fake = createFakeCalle({ scenario: SCENARIOS.never_asked });
    const call = await clientFor(fake).calls.createAndWait(
      { task: "Reach account services and confirm the status of reference 88431." },
      { intervalMs: 1, timeoutMs: 2000 },
    );

    // Everything the platform reports looks good.
    expect(call.taskCompleted).toBe(true);
    expect(call.completionConfidence?.score).toBe(0.91);
    expect(call.structuredResult).toMatchObject({ reference_status: "in_review" });

    // And it is not supported by anything that was said.
    const report = runEvidenceGate({
      structuredResult: call.structuredResult,
      transcriptTurns: turnsOf(call),
      probes: PROBES,
      completionConfidence: call.completionConfidence,
    });

    expect(report.verdict).toBe("needs_human");
    expect(report.unsupportedFields).toEqual(["reference_status"]);
  });

  it("returns no usable evidence for a voicemail", async () => {
    const fake = createFakeCalle({ scenario: SCENARIOS.voicemail });
    const call = await clientFor(fake).calls.createAndWait(
      { task: "Reach account services." },
      { intervalMs: 1, timeoutMs: 2000 },
    );

    const report = runEvidenceGate({
      structuredResult: call.structuredResult,
      transcriptTurns: turnsOf(call),
      probes: PROBES,
      completionConfidence: call.completionConfidence,
    });
    expect(report.verdict).toBe("needs_human");
  });

  it("reproduces the idempotent replay that looks like a new call", async () => {
    const fake = createFakeCalle({ scenario: SCENARIOS.ivr_traversal });
    const client = clientFor(fake);

    const first = await client.calls.create({ task: "Reach account services." }, { idempotencyKey: "hl1_same" });
    const second = await client.calls.create({ task: "Reach account services." }, { idempotencyKey: "hl1_same" });

    // Same call, and nothing in the response says so — issue #315.
    expect(second.id).toBe(first.id);
    expect(fake.createdCount).toBe(1);
    expect(fake.idempotencyKeysSeen).toEqual(["hl1_same", "hl1_same"]);
  });

  it("classifies a bare 503 from call creation as retryable", async () => {
    const fake = createFakeCalle({ scenario: SCENARIOS.provider_unavailable });
    const client = clientFor(fake);

    await expect(client.calls.create({ task: "Reach account services." })).rejects.toThrow(CalleAPIError);

    try {
      await client.calls.create({ task: "Reach account services." });
      expect.unreachable("create should have thrown");
    } catch (error) {
      const classification = classifyFailure(error);
      expect(classification.class).toBe("retryable");
      expect(classification.code).toBe("provider_unavailable");
      expect(classification.reuseIdempotencyKey).toBe(true);
    }
  });

  it("times out on a call that dials late, and does not treat that as no call", async () => {
    // Issue #283. `waitForResult` gives up; the call is still alive.
    const fake = createFakeCalle({ scenario: SCENARIOS.late_dial });
    const client = clientFor(fake);

    const created = await client.calls.create({ task: "Reach account services." });
    await expect(
      client.calls.waitForResult(created.id, { intervalMs: 1, timeoutMs: 30 }),
    ).rejects.toSatisfy((error: unknown) => classifyFailure(error).class === "reconcile");

    // The call completes afterwards. A client that retried on timeout would
    // by now have placed a second real call.
    fake.settle(created.id);
    const reconciled = await client.calls.get(created.id);
    expect(reconciled.status).toBe("completed");
  });
});
