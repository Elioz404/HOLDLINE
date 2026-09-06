/**
 * Idempotency keys.
 *
 * The rule this module enforces structurally: a key is derived from the
 * business event that authorized the call, never from the attempt that
 * happens to be running. There is no timestamp parameter and no random
 * source in this file, so a caller cannot accidentally mint a fresh key on
 * retry and turn one authorization into two phone calls.
 *
 * It also solves a second problem. CALL-E issue #315 reports that reusing a
 * key returns HTTP 201 Created with the *existing* call, which is
 * indistinguishable from a new one — the reporter lost about two hours to a
 * call that never rang. `IdempotencyLedger` records keys locally so the
 * client can tell a replay from a fresh dispatch without provider support.
 */

import { createHash } from "node:crypto";

export interface CallIntent {
  /** The workflow placing the call, e.g. `"status-watch"`. */
  readonly workflow: string;
  /**
   * The stable identifier of the thing being called *about* — an order id, a
   * claim number, a ticket id. Not a phone number, and not a row index.
   */
  readonly subjectId: string;
  /** What this call is for. Two intents on one subject must differ here. */
  readonly intent: string;
  /**
   * Optional discriminator for a legitimately repeated call on the same
   * subject and intent, such as a scheduled re-check. Must itself be derived
   * from something stable, e.g. `"check-3"`, never `Date.now()`.
   */
  readonly sequence?: string;
}

const FIELD = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export class InvalidIntentError extends Error {
  constructor(field: string, value: string) {
    super(
      `Idempotency intent field \`${field}\` is not a stable identifier: ${JSON.stringify(value)}. ` +
        "Use the id of the authorizing business record.",
    );
    this.name = "InvalidIntentError";
  }
}

function requireStable(field: keyof CallIntent, value: string): string {
  if (!FIELD.test(value)) throw new InvalidIntentError(field, value);
  return value;
}

/**
 * Derive the key. Same intent in, same key out, on every process and every day.
 *
 * The returned key is `hl1_` followed by 32 hex characters of SHA-256 over the
 * canonical intent string. The prefix makes the key recognizable in provider
 * dashboards; the truncation keeps it short enough for a header.
 */
export function deriveIdempotencyKey(intent: CallIntent): string {
  const canonical = [
    "holdline.v1",
    requireStable("workflow", intent.workflow),
    requireStable("subjectId", intent.subjectId),
    requireStable("intent", intent.intent),
    intent.sequence === undefined ? "" : requireStable("sequence", intent.sequence),
  ].join("|");

  return `hl1_${createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 32)}`;
}

export type DispatchKind = "first_dispatch" | "replay";

export interface LedgerEntry {
  readonly key: string;
  /** Call id the provider returned the first time this key was used. */
  readonly callId: string;
}

/**
 * Records which idempotency keys this application has already sent.
 *
 * In-memory here. A production deployment swaps this for a durable store; the
 * interface is the point, and the tests exercise the semantics rather than the
 * storage.
 */
export class IdempotencyLedger {
  private readonly entries = new Map<string, LedgerEntry>();

  /**
   * Call before dispatching. Returns `"replay"` when this key has been used,
   * along with the call id it produced, so the caller can fetch that call
   * instead of believing a 201 means a new phone rang.
   */
  public inspect(key: string): { kind: DispatchKind; entry?: LedgerEntry } {
    const entry = this.entries.get(key);
    return entry ? { kind: "replay", entry } : { kind: "first_dispatch" };
  }

  /** Call after the provider accepts a dispatch. Recording twice is an error. */
  public record(key: string, callId: string): LedgerEntry {
    const existing = this.entries.get(key);
    if (existing) {
      throw new Error(
        `Idempotency key ${key} was already recorded against call ${existing.callId}. ` +
          "Inspect before dispatching.",
      );
    }
    const entry: LedgerEntry = { key, callId };
    this.entries.set(key, entry);
    return entry;
  }

  public get size(): number {
    return this.entries.size;
  }
}
