/**
 * The queue engine.
 *
 * One question, asked of many places at once, and answered only where the
 * transcript supports it.
 *
 * CALL-E's Calls API takes a single `task` and a list of `recipients`, and
 * returns a per-recipient structured result when given a
 * `recipientResultSchema`. That is the primitive this engine is built on: a
 * fan-out is one dispatch, one idempotency key, one intent.
 *
 * Three rules hold throughout:
 *
 *   1. Preview is the default. Nothing dials unless mode is `"live"`.
 *   2. A result is withheld unless the Evidence Gate can point at the bot turn
 *      that asked for it.
 *   3. An unknown outcome is never retried. It is reconciled.
 */

import { CalleClient, type Call, type CallRecipient } from "@call-e/calle";

import { checkPhone, maskPhone, type PhoneRejection } from "../core/phone.js";
import { compileTask, type CompiledTask, type TaskSegment } from "../core/task-compiler.js";
import { classifyFailure, type Classification } from "../core/outcome.js";
import { deriveIdempotencyKey, IdempotencyLedger } from "../core/idempotency.js";
import { gatedResult, runEvidenceGate } from "../evidence/gate.js";
import type { CallTranscriptTurn, FieldProbe, GateReport } from "../evidence/types.js";

export interface QueueTarget {
  /** Stable id of the place being called: a vendor id, a facility code. */
  readonly subjectId: string;
  readonly phone: string;
  /** Free-form label for reports. Never a phone number. */
  readonly label?: string;
}

export interface QueueRequest {
  /** Workflow name, part of the idempotency intent. */
  readonly workflow: string;
  /** What this batch is for, part of the idempotency intent. */
  readonly intent: string;
  /** Stable id of the batch itself — the authorizing record. */
  readonly batchId: string;
  /** The question, in plain language. Becomes the required task segment. */
  readonly goal: string;
  /** Optional menu-routing instruction, dropped first if the task overflows. */
  readonly routingHint?: string;
  readonly targets: readonly QueueTarget[];
  readonly probes: readonly FieldProbe[];
  readonly recipientResultSchema: Record<string, unknown>;
  readonly minConfidence?: number;
  /** `"preview"` (default) plans without dialing. `"live"` places calls. */
  readonly mode?: "preview" | "live";
}

export interface RejectedTarget {
  readonly subjectId: string;
  readonly maskedPhone: string;
  readonly reason: PhoneRejection;
}

export interface QueuePlan {
  readonly task: CompiledTask;
  readonly idempotencyKey: string;
  readonly dialable: readonly QueueTarget[];
  readonly rejected: readonly RejectedTarget[];
}

export interface TargetOutcome {
  readonly subjectId: string;
  readonly maskedPhone: string;
  readonly label: string | undefined;
  readonly gate: GateReport;
  /** Fields the gate could vouch for. Everything else is `null`. */
  readonly result: Record<string, unknown>;
  /**
   * This recipient's transcript turns. Carried so callers can observe the menu
   * route and the call duration without refetching the call. It contains a real
   * conversation: redact before it reaches a log or a screen.
   */
  readonly transcript: readonly CallTranscriptTurn[];
}

export type QueueOutcome =
  | { readonly kind: "preview"; readonly plan: QueuePlan }
  | {
      readonly kind: "completed";
      readonly plan: QueuePlan;
      readonly callId: string;
      readonly replayed: boolean;
      readonly targets: readonly TargetOutcome[];
    }
  | {
      readonly kind: "unresolved";
      readonly plan: QueuePlan;
      readonly callId: string | null;
      readonly classification: Classification;
    };

export class NoDialableTargetsError extends Error {
  constructor(public readonly rejected: readonly RejectedTarget[]) {
    super(`No dialable targets: ${rejected.map((r) => `${r.subjectId}=${r.reason}`).join(", ")}`);
    this.name = "NoDialableTargetsError";
  }
}

/**
 * Build the plan without touching the network.
 *
 * Every target is validated here, so a malformed number is caught before any
 * call is dispatched rather than failing one recipient mid-batch.
 */
export function planQueue(request: QueueRequest): QueuePlan {
  const segments: TaskSegment[] = [
    { label: "goal", text: request.goal, priority: "required" },
    {
      label: "disclosure",
      text: "Say you are an automated assistant when a person answers.",
      priority: "required",
    },
  ];
  if (request.routingHint) {
    segments.splice(1, 0, { label: "routing", text: request.routingHint, priority: "high" });
  }

  const dialable: QueueTarget[] = [];
  const rejected: RejectedTarget[] = [];
  for (const target of request.targets) {
    const check = checkPhone(target.phone);
    if (check.ok) dialable.push(target);
    else rejected.push({ subjectId: target.subjectId, maskedPhone: maskPhone(target.phone), reason: check.reason });
  }

  return {
    task: compileTask(segments),
    idempotencyKey: deriveIdempotencyKey({
      workflow: request.workflow,
      subjectId: request.batchId,
      intent: request.intent,
    }),
    dialable,
    rejected,
  };
}

/** Every transcript turn across a recipient's attempts, oldest first. */
function turnsFor(recipient: CallRecipient): CallTranscriptTurn[] {
  return recipient.attempts.flatMap((attempt) => attempt.transcriptTurns as CallTranscriptTurn[]);
}

function judge(request: QueueRequest, call: Call, plan: QueuePlan): TargetOutcome[] {
  return call.recipients.map((recipient, index) => {
    const target = plan.dialable[index];
    const turns = turnsFor(recipient);
    const gate = runEvidenceGate({
      structuredResult: recipient.structuredResult,
      transcriptTurns: turns,
      probes: request.probes,
      completionConfidence: call.completionConfidence,
      ...(request.minConfidence === undefined ? {} : { minConfidence: request.minConfidence }),
    });

    return {
      subjectId: target?.subjectId ?? `unknown-${index}`,
      maskedPhone: maskPhone(recipient.phones[0] ?? ""),
      label: target?.label,
      gate,
      result: gatedResult(gate, recipient.structuredResult),
      transcript: turns,
    };
  });
}

export interface RunQueueOptions {
  readonly client: CalleClient;
  readonly ledger?: IdempotencyLedger;
  readonly intervalMs?: number;
  readonly timeoutMs?: number;
}

/**
 * Plan, then — only in live mode — dispatch, wait, and judge.
 *
 * On any unknown outcome the engine returns `kind: "unresolved"` carrying the
 * classification and the call id when it has one. It does not retry. The
 * caller reconciles, because only the caller knows whether a second real call
 * to a real person is acceptable.
 */
export async function runQueue(
  request: QueueRequest,
  options: RunQueueOptions,
): Promise<QueueOutcome> {
  const plan = planQueue(request);
  if (plan.dialable.length === 0) throw new NoDialableTargetsError(plan.rejected);

  if ((request.mode ?? "preview") === "preview") {
    return { kind: "preview", plan };
  }

  const ledger = options.ledger ?? new IdempotencyLedger();
  const seen = ledger.inspect(plan.idempotencyKey);
  if (seen.kind === "replay") {
    // This intent already went out. Fetch what it produced instead of
    // dispatching again and trusting a 201 to mean a phone rang.
    const existing = await options.client.calls.get(seen.entry!.callId);
    return {
      kind: "completed",
      plan,
      callId: existing.id,
      replayed: true,
      targets: judge(request, existing, plan),
    };
  }

  let created: Call;
  try {
    created = await options.client.calls.create(
      {
        task: plan.task.task,
        recipients: plan.dialable.map((target) => ({ phone: target.phone })),
        recipientResultSchema: request.recipientResultSchema,
        metadata: { holdline_batch: request.batchId, holdline_workflow: request.workflow },
      },
      { idempotencyKey: plan.idempotencyKey },
    );
  } catch (error) {
    return { kind: "unresolved", plan, callId: null, classification: classifyFailure(error) };
  }

  ledger.record(plan.idempotencyKey, created.id);

  try {
    const settled = await options.client.calls.waitForResult(created.id, {
      ...(options.intervalMs === undefined ? {} : { intervalMs: options.intervalMs }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
    return {
      kind: "completed",
      plan,
      callId: settled.id,
      replayed: false,
      targets: judge(request, settled, plan),
    };
  } catch (error) {
    // The call exists and may still be in flight. Hand back its id so the
    // caller can reconcile rather than re-dial.
    return { kind: "unresolved", plan, callId: created.id, classification: classifyFailure(error) };
  }
}
