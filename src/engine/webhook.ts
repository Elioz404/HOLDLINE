/**
 * The webhook receiver.
 *
 * CALL-E's own SDK marks its signature helpers deprecated with the reason
 * spelled out: *"Current CALL-E webhook deliveries are not signed."* Anyone on
 * the internet who learns your webhook URL can therefore post anything to it.
 *
 * So this receiver treats a delivery as **a doorbell, not a document**. It
 * reads exactly one thing out of the body — a call id — and then throws the
 * rest away and asks the API what happened. Nothing in the payload reaches the
 * Evidence Gate, the ledger, or any caller.
 *
 * Two more consequences follow from an unauthenticated endpoint:
 *
 *   - **Only calls this application dispatched are accepted.** An id we never
 *     sent is refused without a fetch, so the endpoint cannot be used to make
 *     us enumerate someone else's calls.
 *   - **Deliveries are replay-safe.** Webhooks are retried; a call already
 *     processed is acknowledged and skipped rather than judged twice.
 */

import type { CalleClient, Call } from "@call-e/calle";

import { classifyFailure, type Classification } from "../core/outcome.js";

export type WebhookVerdict =
  | "unparseable"
  | "no_call_id"
  | "unknown_call"
  | "duplicate"
  | "not_terminal"
  | "processed"
  | "fetch_failed";

export interface WebhookResult {
  readonly verdict: WebhookVerdict;
  readonly callId: string | null;
  /** The authoritative call, fetched from the API. Never the payload. */
  readonly call: Call | null;
  readonly classification: Classification | null;
  readonly note: string;
}

/**
 * Which call ids this application is willing to act on, and which it has
 * already finished with. Backed by whatever the deployment uses; the queue
 * engine's idempotency ledger supplies the first set in practice.
 */
export interface DispatchRegistry {
  /** Did we dispatch this call id? */
  has(callId: string): boolean;
  /** Have we already processed a terminal delivery for it? */
  isProcessed(callId: string): boolean;
  markProcessed(callId: string): void;
}

export class InMemoryDispatchRegistry implements DispatchRegistry {
  private readonly dispatched = new Set<string>();
  private readonly processed = new Set<string>();

  public register(callId: string): void {
    this.dispatched.add(callId);
  }
  public has(callId: string): boolean {
    return this.dispatched.has(callId);
  }
  public isProcessed(callId: string): boolean {
    return this.processed.has(callId);
  }
  public markProcessed(callId: string): void {
    this.processed.add(callId);
  }
}

const TERMINAL = new Set(["completed", "failed", "canceled"]);

/**
 * Pull a call id out of an untrusted body.
 *
 * Accepts the shapes a delivery plausibly uses and validates the id's format.
 * Everything else in the body is discarded without being read.
 */
function extractCallId(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;
  const data = (record["data"] ?? {}) as Record<string, unknown>;

  const candidate =
    record["call_id"] ?? record["callId"] ?? data["call_id"] ?? data["id"] ?? record["id"];

  if (typeof candidate !== "string") return null;
  // Ids are opaque, but they are ours to recognize: `call_` plus url-safe text.
  return /^call_[A-Za-z0-9_-]{1,128}$/.test(candidate) ? candidate : null;
}

export interface HandleWebhookOptions {
  readonly client: CalleClient;
  readonly registry: DispatchRegistry;
}

/**
 * Handle one delivery.
 *
 * Always resolves — a webhook endpoint that throws is a webhook endpoint that
 * gets retried forever. The verdict says what happened and the caller decides
 * what status code to return.
 */
export async function handleWebhook(
  rawBody: string,
  options: HandleWebhookOptions,
): Promise<WebhookResult> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return {
      verdict: "unparseable",
      callId: null,
      call: null,
      classification: null,
      note: "Body was not JSON. Discarded without further processing.",
    };
  }

  const callId = extractCallId(parsed);
  if (callId === null) {
    return {
      verdict: "no_call_id",
      callId: null,
      call: null,
      classification: null,
      note: "No recognizable call id in the delivery. Nothing was fetched.",
    };
  }

  if (!options.registry.has(callId)) {
    // Deliveries are unauthenticated, so an id we did not dispatch is refused
    // before any API call rather than after.
    return {
      verdict: "unknown_call",
      callId,
      call: null,
      classification: null,
      note: "This application did not dispatch that call. Refused without a fetch.",
    };
  }

  if (options.registry.isProcessed(callId)) {
    return {
      verdict: "duplicate",
      callId,
      call: null,
      classification: null,
      note: "Already processed. Webhook retries are expected and this is a no-op.",
    };
  }

  let call: Call;
  try {
    // The delivery said something happened. The API says what.
    call = await options.client.calls.get(callId);
  } catch (error) {
    return {
      verdict: "fetch_failed",
      callId,
      call: null,
      classification: classifyFailure(error),
      note: "Could not reach the API to confirm. Not marked processed, so a retry can succeed.",
    };
  }

  if (!TERMINAL.has(call.status)) {
    return {
      verdict: "not_terminal",
      callId,
      call,
      classification: null,
      note: `Call is ${call.status}. Waiting for a terminal state before judging.`,
    };
  }

  options.registry.markProcessed(callId);
  return {
    verdict: "processed",
    callId,
    call,
    classification: null,
    note: "Fetched from the API and ready to judge. Nothing from the payload was used.",
  };
}
