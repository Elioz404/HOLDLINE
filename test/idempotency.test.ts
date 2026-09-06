import { describe, expect, it } from "vitest";
import {
  IdempotencyLedger,
  InvalidIntentError,
  deriveIdempotencyKey,
} from "../src/core/idempotency.js";

const intent = { workflow: "status-watch", subjectId: "claim-88431", intent: "status-check" };

describe("deriveIdempotencyKey", () => {
  it("is stable across calls", () => {
    expect(deriveIdempotencyKey(intent)).toBe(deriveIdempotencyKey({ ...intent }));
  });

  it("is stable across processes", () => {
    // Pinned literal: if this changes, previously dispatched intents would mint
    // new keys and duplicate real calls. Changing it is a migration, not a fix.
    expect(deriveIdempotencyKey(intent)).toBe("hl1_f7a199619df096369a3c0bfc76c8f9af");
  });

  it("separates different intents on the same subject", () => {
    expect(deriveIdempotencyKey({ ...intent, intent: "callback" })).not.toBe(
      deriveIdempotencyKey(intent),
    );
  });

  it("separates deliberate repeats via sequence", () => {
    expect(deriveIdempotencyKey({ ...intent, sequence: "check-2" })).not.toBe(
      deriveIdempotencyKey({ ...intent, sequence: "check-3" }),
    );
  });

  it("rejects an unstable identifier instead of hashing it", () => {
    // The whole point: there is no timestamp parameter, and a caller who
    // smuggles one in through subjectId is stopped rather than obeyed.
    expect(() => deriveIdempotencyKey({ ...intent, subjectId: "" })).toThrow(InvalidIntentError);
    expect(() => deriveIdempotencyKey({ ...intent, subjectId: "claim 88431" })).toThrow(
      InvalidIntentError,
    );
  });
});

describe("IdempotencyLedger", () => {
  it("reports a first dispatch, then a replay", () => {
    const ledger = new IdempotencyLedger();
    const key = deriveIdempotencyKey(intent);

    expect(ledger.inspect(key)).toEqual({ kind: "first_dispatch" });
    ledger.record(key, "call_abc123");

    // CALL-E issue #315: the provider answers a reused key with 201 Created and
    // the existing call, which reads as a new one. The ledger is how a client
    // tells the difference without provider support.
    const seen = ledger.inspect(key);
    expect(seen.kind).toBe("replay");
    expect(seen.entry?.callId).toBe("call_abc123");
  });

  it("refuses to record the same key twice", () => {
    const ledger = new IdempotencyLedger();
    ledger.record("hl1_x", "call_1");
    expect(() => ledger.record("hl1_x", "call_2")).toThrow(/already recorded/);
  });
});
