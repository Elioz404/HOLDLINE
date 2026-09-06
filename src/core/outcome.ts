/**
 * Failure classification.
 *
 * Most clients sort call failures into two buckets: retry, or give up. That is
 * the wrong shape for a telephone. A third bucket is mandatory.
 *
 * CALL-E issue #283 documents an outbound call that sat queued for 49 minutes,
 * raised `CalleTimeoutError` in the SDK's `waitForResult`, and then dialed
 * anyway and completed. A timeout therefore does not mean "no call happened".
 * Retrying it places a second real call to a real person.
 *
 * So: `retryable` (nothing was dispatched, same intent is safe to send again),
 * `deterministic` (the request is wrong and will stay wrong), and `reconcile`
 * (the outcome is unknown — go find out what happened before doing anything).
 *
 * This mirrors the repository's own guidance that an unknown call outcome is a
 * state to reconcile rather than an error to retry.
 */

import {
  CalleAPIError,
  CalleAuthenticationError,
  CalleConnectionError,
  CalleRateLimitError,
  CalleTimeoutError,
} from "@call-e/calle";

export type FailureClass = "retryable" | "deterministic" | "reconcile";

export interface Classification {
  readonly class: FailureClass;
  /** Stable machine code, provider code when there is one. */
  readonly code: string;
  /** Why this class was chosen. Written for a human reading an incident. */
  readonly reason: string;
  /**
   * True when the caller must keep the original idempotency key. Reusing the
   * key preserves the intent; minting a new one is how retries become
   * duplicate calls.
   */
  readonly reuseIdempotencyKey: boolean;
}

/** Provider codes documented as safe to retry with the same intent. */
const RETRYABLE_CODES = new Set([
  "rate_limit_exceeded",
  "provider_unavailable",
  "internal_error",
]);

export function classifyFailure(error: unknown): Classification {
  // A timeout is the dangerous case: the call may still be in flight.
  if (error instanceof CalleTimeoutError) {
    return {
      class: "reconcile",
      code: "wait_timeout",
      reason:
        "The wait timed out. The call may still dial and complete (see CALL-E issue #283). " +
        "Fetch the call by id and reconcile before any further action.",
      reuseIdempotencyKey: true,
    };
  }

  // Connection failures can happen before or after the request was accepted.
  // We cannot tell from here, so we do not guess.
  if (error instanceof CalleConnectionError) {
    return {
      class: "reconcile",
      code: "connection_lost",
      reason:
        "The connection failed without a response. Whether the call task was created is unknown. " +
        "Replay the same idempotency key to find out rather than creating a new intent.",
      reuseIdempotencyKey: true,
    };
  }

  if (error instanceof CalleAuthenticationError) {
    return {
      class: "deterministic",
      code: error.code,
      reason: "Credentials were rejected. Retrying with the same key changes nothing.",
      reuseIdempotencyKey: false,
    };
  }

  if (error instanceof CalleRateLimitError) {
    return {
      class: "retryable",
      code: error.code,
      reason: "Rate limited before dispatch. Back off and resend the same intent.",
      reuseIdempotencyKey: true,
    };
  }

  if (error instanceof CalleAPIError) {
    if (RETRYABLE_CODES.has(error.code)) {
      return {
        class: "retryable",
        code: error.code,
        reason: `Provider reported \`${error.code}\`, documented as retryable. Resend the same intent.`,
        reuseIdempotencyKey: true,
      };
    }
    // 5xx that is not a known code: we do not know whether it dispatched.
    if (error.status >= 500) {
      return {
        class: "reconcile",
        code: error.code,
        reason: `Unrecognized server error \`${error.code}\` (HTTP ${error.status}). Dispatch state unknown.`,
        reuseIdempotencyKey: true,
      };
    }
    return {
      class: "deterministic",
      code: error.code,
      reason: `Request rejected with \`${error.code}\` (HTTP ${error.status}). The request itself must change.`,
      reuseIdempotencyKey: false,
    };
  }

  // An error we do not recognize is not assumed safe.
  return {
    class: "reconcile",
    code: "unknown_error",
    reason: "Unrecognized failure. Treated as unknown outcome rather than assumed harmless.",
    reuseIdempotencyKey: true,
  };
}
