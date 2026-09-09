/**
 * The queue engine.
 *
 * One question, asked of many places at once, and answered only where the
 * transcript supports it.
 *
 * CALL-E's Calls API takes a single `task` and a list of `recipients`, and
 * returns a per-recipient structured result when given a
 * `recipientResultSchema`. That looked like the primitive to build on, and for
 * most of this project's life the engine used it: one dispatch, one
 * idempotency key, many recipients.
 *
 * A live batch retired that design. A multi-recipient call returns no
 * `transcript_turns` for any recipient — the spoken content arrives only as a
 * prose `summary` — while the same numbers, dialled one recipient at a time,
 * return turns. The gate judges transcripts and will not read a summary, so
 * every field in that batch was withheld. Correct, and useless.
 *
 * So a batch is now one call per target, dispatched together. The promise is
 * unchanged — one question, many places, a verdict each, one authorizing
 * record — and each target derives its own idempotency key from that record,
 * which also means reconciling one target cannot re-dial the others.
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
  /** The call placed for this target, or null if creating it failed. */
  readonly callId: string | null;
  /**
   * Set when this target's own call did not reach a terminal state. The other
   * targets in the batch are unaffected: each one is its own call now, so one
   * timeout no longer decides the batch.
   */
  readonly unresolved: Classification | null;
}

export type QueueOutcome =
  | { readonly kind: "preview"; readonly plan: QueuePlan }
  | {
      readonly kind: "completed";
      readonly plan: QueuePlan;
      /**
       * The first target's call id, kept because a single-target dispatch is
       * still the common case and callers read it. With several targets there
       * are several calls: read `callIds`, or each target's own `callId`.
       */
      readonly callId: string;
      /** One call id per target that was created, in target order. */
      readonly callIds: readonly string[];
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

/**
 * Judge one target against the call placed for it.
 *
 * This used to walk `call.recipients` from a single fan-out dispatch. A live
 * batch showed why it cannot: CALL-E returns `transcript_turns` per recipient
 * for a one-recipient call and returns none for a multi-recipient one, putting
 * the spoken content in a prose `summary` instead. The gate judges transcripts
 * and refuses to read a summary — a summary is what the model concluded, which
 * is the thing this project exists not to trust — so every field in that batch
 * came back `no_transcript` and was withheld. Correct, and useless.
 *
 * So a batch is now one call per target. The engine keeps its promise (one
 * question, many places, a verdict each) by asking the platform only for what
 * it demonstrably returns.
 */
function judgeOne(
  request: QueueRequest,
  call: Call,
  target: QueueTarget,
  callId: string,
): TargetOutcome {
  const recipient = call.recipients[0];
  const turns = recipient ? turnsFor(recipient) : [];
  const gate = runEvidenceGate({
    structuredResult: recipient?.structuredResult ?? null,
    transcriptTurns: turns,
    probes: request.probes,
    completionConfidence: call.completionConfidence,
    ...(request.minConfidence === undefined ? {} : { minConfidence: request.minConfidence }),
  });

  return {
    subjectId: target.subjectId,
    maskedPhone: maskPhone(target.phone),
    label: target.label,
    gate,
    result: gatedResult(gate, recipient?.structuredResult ?? null),
    transcript: turns,
    callId,
    unresolved: null,
  };
}

/** A target whose own call never settled. Nothing is judged; nothing is lost. */
function unresolvedTarget(
  target: QueueTarget,
  callId: string | null,
  classification: Classification,
): TargetOutcome {
  return {
    subjectId: target.subjectId,
    maskedPhone: maskPhone(target.phone),
    label: target.label,
    gate: runEvidenceGate({
      structuredResult: null,
      transcriptTurns: [],
      probes: [],
      completionConfidence: null,
    }),
    result: {},
    transcript: [],
    callId,
    unresolved: classification,
  };
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
  const waitOptions = {
    ...(options.intervalMs === undefined ? {} : { intervalMs: options.intervalMs }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  };

  // One call per target, all in flight together. The key is derived per target
  // from the same authorizing record, so re-running the batch fetches each
  // existing call rather than dialing anyone twice — and a retry aimed at one
  // target no longer risks re-dialing the rest.
  const dispatched = await Promise.all(
    plan.dialable.map(async (target): Promise<{ outcome: TargetOutcome; replayed: boolean }> => {
      const key = deriveIdempotencyKey({
        workflow: request.workflow,
        subjectId: request.batchId,
        intent: request.intent,
        sequence: target.subjectId,
      });

      const seen = ledger.inspect(key);
      if (seen.kind === "replay") {
        // This intent already went out for this target. Fetch what it produced
        // instead of dispatching again and trusting a 201 to mean a phone rang.
        try {
          const existing = await options.client.calls.get(seen.entry!.callId);
          return { outcome: judgeOne(request, existing, target, existing.id), replayed: true };
        } catch (error) {
          return {
            outcome: unresolvedTarget(target, seen.entry!.callId, classifyFailure(error)),
            replayed: true,
          };
        }
      }

      let created: Call;
      try {
        created = await options.client.calls.create(
          {
            task: plan.task.task,
            recipients: [{ phone: target.phone }],
            recipientResultSchema: request.recipientResultSchema,
            metadata: {
              holdline_batch: request.batchId,
              holdline_workflow: request.workflow,
              holdline_subject: target.subjectId,
            },
          },
          { idempotencyKey: key },
        );
      } catch (error) {
        return { outcome: unresolvedTarget(target, null, classifyFailure(error)), replayed: false };
      }

      ledger.record(key, created.id);

      try {
        const settled = await options.client.calls.waitForResult(created.id, waitOptions);
        return { outcome: judgeOne(request, settled, target, settled.id), replayed: false };
      } catch (error) {
        // The call exists and may still be in flight. Carry its id so the
        // caller can reconcile that one target rather than re-dial anything.
        return {
          outcome: unresolvedTarget(target, created.id, classifyFailure(error)),
          replayed: false,
        };
      }
    }),
  );

  const targets = dispatched.map((entry) => entry.outcome);
  const callIds = targets.map((t) => t.callId).filter((id): id is string => id !== null);

  // Unresolved means *nothing settled*, not *nothing was created*: a call that
  // timed out still has an id, and reporting that batch as completed would tell
  // the caller a phone had been answered when the truth is that nobody knows.
  // A partial failure is not unresolved — it is reported per target, because a
  // timeout on one number says nothing about the others.
  const settled = targets.filter((target) => target.unresolved === null);
  if (settled.length === 0) {
    const first = targets[0];
    return {
      kind: "unresolved",
      plan,
      callId: first?.callId ?? null,
      classification: first?.unresolved ?? classifyFailure(new Error("no call was created")),
    };
  }

  return {
    kind: "completed",
    plan,
    callId: callIds[0]!,
    callIds,
    replayed: dispatched.every((entry) => entry.replayed),
    targets,
  };
}
