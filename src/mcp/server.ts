/**
 * HOLDLINE as an MCP server.
 *
 * Three tools, and the split between them is the safety model:
 *
 *   plan_hold    compiles the task, validates every number, and reports what
 *                the ledger already answers. Places no call, ever.
 *   run_hold     dispatches. Requires an explicit `confirm`, and refuses
 *                without it — there is no flag that skips the confirmation.
 *   get_verdict  fetches a call by id and judges it against the transcript.
 *
 * An agent driving this cannot reach a telephone by accident. The only tool
 * that dials is the one that must be told, in the same call, that dialing is
 * intended.
 *
 * ── Simulation mode ────────────────────────────────────────────────────────
 * With `HOLDLINE_SIMULATE=1` the server runs against the fake transport
 * instead of the network. Every response then carries `simulated: true` and a
 * one-line notice, so a simulated result cannot be mistaken for a real call —
 * not in a transcript, not in a screen recording, not in a log. This exists so
 * the tools can be exercised and reviewed without credentials, which is the
 * state this project is currently in.
 *
 * Every phone number leaving this server is masked.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CalleClient } from "@call-e/calle";
import { z } from "zod";

import { maskPhone } from "../core/phone.js";
import { redact, redactError } from "../core/redact.js";
import { IdempotencyLedger } from "../core/idempotency.js";
import { classifyFailure } from "../core/outcome.js";
import { runEvidenceGate, gatedResult } from "../evidence/gate.js";
import type { CallTranscriptTurn, FieldProbe } from "../evidence/types.js";
import { planQueue, runQueue, type QueueRequest, type QueueTarget } from "../engine/queue.js";
import { FactLedger } from "../ledger/facts.js";
import { RouteCache, observeRoute } from "../ledger/routes.js";
import { SCENARIOS, createFakeCalle } from "../testing/fake-calle.js";

const SIMULATED = process.env["HOLDLINE_SIMULATE"] === "1";
const SIMULATION_NOTICE =
  "SIMULATED — no telephone was involved. Backed by the local fake transport, not the CALL-E network.";

// ── Shared input shapes ──────────────────────────────────────────────────────

const targetShape = z.object({
  subjectId: z
    .string()
    .min(1)
    .describe("Stable id of the place being called: a vendor id, a facility code. Not a phone number."),
  phone: z.string().describe("E.164, e.g. +14155550199. No spaces, no extension."),
  label: z.string().optional().describe("Human-readable name for reports."),
});

const fieldShape = z.object({
  name: z.string().min(1).describe("Result field this question fills."),
  asks: z
    .array(z.string().min(1))
    .min(1)
    .describe(
      "Phrases that identify the agent raising this topic. Write the words the agent would say, not the field name.",
    ),
  required: z.boolean().optional().default(true),
});

const planInput = {
  goal: z.string().min(1).describe("The question, in plain language. Kept within the API's 255-character task limit."),
  targets: z.array(targetShape).min(1),
  fields: z.array(fieldShape).min(1),
  routingHint: z
    .string()
    .optional()
    .describe("Menu-routing instruction, e.g. 'Reach the billing department'. Dropped first if the task overflows."),
  workflow: z.string().default("holdline").describe("Workflow name; part of the idempotency intent."),
  intent: z.string().default("ask").describe("What this batch is for; part of the idempotency intent."),
  batchId: z.string().min(1).describe("Stable id of the authorizing record. Never a timestamp or a random value."),
};

// ── State ────────────────────────────────────────────────────────────────────

const facts = new FactLedger();
const routes = new RouteCache();
const idempotency = new IdempotencyLedger();

function makeClient(): CalleClient {
  if (SIMULATED) {
    const fake = createFakeCalle({ scenario: SCENARIOS.ivr_traversal });
    return new CalleClient({ apiKey: "simulated", fetch: fake.fetch });
  }
  const apiKey = process.env["CALLE_API_KEY"];
  if (!apiKey) {
    throw new Error(
      "CALLE_API_KEY is not set. Set it to place real calls, or set HOLDLINE_SIMULATE=1 to exercise the tools against the local fake transport.",
    );
  }
  return new CalleClient({ apiKey });
}

const probesFrom = (fields: readonly z.infer<typeof fieldShape>[]): FieldProbe[] =>
  fields.map((field) => ({
    field: field.name,
    required: field.required ?? true,
    asks: field.asks,
  }));

const schemaFrom = (fields: readonly z.infer<typeof fieldShape>[]): Record<string, unknown> => ({
  type: "object",
  properties: Object.fromEntries(fields.map((field) => [field.name, { type: "string" }])),
  required: fields.filter((f) => f.required ?? true).map((f) => f.name),
});

const requestFrom = (
  args: {
    goal: string;
    targets: z.infer<typeof targetShape>[];
    fields: z.infer<typeof fieldShape>[];
    routingHint?: string | undefined;
    workflow: string;
    intent: string;
    batchId: string;
  },
  mode: "preview" | "live",
): QueueRequest => ({
  workflow: args.workflow,
  intent: args.intent,
  batchId: args.batchId,
  goal: args.goal,
  ...(args.routingHint === undefined ? {} : { routingHint: args.routingHint }),
  targets: args.targets as QueueTarget[],
  probes: probesFrom(args.fields),
  recipientResultSchema: schemaFrom(args.fields),
  mode,
});

/** Every tool answers through here, so nothing leaves unmasked or unlabelled. */
function reply(payload: Record<string, unknown>): {
  content: { type: "text"; text: string }[];
  isError?: boolean;
} {
  const body = redact({ ...(SIMULATED ? { simulated: true, notice: SIMULATION_NOTICE } : {}), ...payload });
  return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
}

function failure(payload: Record<string, unknown>) {
  return { ...reply(payload), isError: true };
}

// ── Server ───────────────────────────────────────────────────────────────────

export function createServer(): McpServer {
  const server = new McpServer({ name: "holdline", version: "0.1.0" });

  server.registerTool(
    "plan_hold",
    {
      title: "Plan a batch of calls",
      description:
        "Compile the task, validate every phone number, derive the idempotency key, and report which targets the freshness ledger already answers. Places no call.",
      inputSchema: planInput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const request = requestFrom(args, "preview");
        const plan = planQueue(request);
        const primary = args.fields[0]?.name;
        const cached = primary
          ? facts.partition(args.targets, primary)
          : { answered: [], toCall: args.targets };

        return reply({
          task: plan.task.task,
          taskChars: `${plan.task.used}/${plan.task.budget}`,
          droppedSegments: plan.task.dropped,
          idempotencyKey: plan.idempotencyKey,
          dialable: plan.dialable.map((t) => ({
            subjectId: t.subjectId,
            phone: maskPhone(t.phone),
            label: t.label ?? null,
            routeHint: routes.hintFor(t.subjectId),
          })),
          rejected: plan.rejected,
          alreadyAnswered: cached.answered.map((f) => ({
            subjectId: f.subjectId,
            field: f.field,
            value: f.value,
            verifiedAt: new Date(f.verifiedAt).toISOString(),
            supportingTurn: f.supportingTurn,
          })),
          stillNeedsCalling: cached.toCall.length,
          note: "Nothing was dialed. Call run_hold with confirm: true to place these calls.",
        });
      } catch (error) {
        return failure({ error: redactError(error) });
      }
    },
  );

  server.registerTool(
    "run_hold",
    {
      title: "Place the calls",
      description:
        "Dispatch the planned batch as real phone calls and judge each answer against the transcript. Requires confirm: true. Unverifiable fields come back null.",
      inputSchema: { ...planInput, confirm: z.boolean().describe("Must be true. Real people answer these calls.") },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      if (!args.confirm) {
        return failure({
          refused: "confirm was not true",
          note: "run_hold places real phone calls to real people. Set confirm: true in the same request, or use plan_hold to see what would happen.",
        });
      }

      let client: CalleClient;
      try {
        client = makeClient();
      } catch (error) {
        return failure({ error: redactError(error) });
      }

      try {
        const outcome = await runQueue(requestFrom(args, "live"), { client, ledger: idempotency });

        if (outcome.kind === "unresolved") {
          return failure({
            outcome: "unresolved",
            callId: outcome.callId,
            classification: outcome.classification,
            note: "Not retried. An unknown call outcome is reconciled, never re-dialed — a second dispatch would ring a second person.",
          });
        }
        if (outcome.kind === "preview") {
          return reply({ outcome: "preview", task: outcome.plan.task.task });
        }

        return reply({
          outcome: "completed",
          callId: outcome.callId,
          replayed: outcome.replayed,
          targets: outcome.targets.map((target) => ({
            subjectId: target.subjectId,
            phone: target.maskedPhone,
            verdict: target.gate.verdict,
            result: target.result,
            unsupportedFields: target.gate.unsupportedFields,
            reasons: target.gate.reasons,
          })),
        });
      } catch (error) {
        return failure({ error: redactError(error), classification: classifyFailure(error) });
      }
    },
  );

  server.registerTool(
    "get_verdict",
    {
      title: "Judge a call that already happened",
      description:
        "Fetch a call by id and check every field against the transcript turns the agent actually spoke. Reports which values the call established and which it did not.",
      inputSchema: {
        callId: z.string().min(1).describe("CALL-E call id, e.g. call_abc123."),
        fields: z.array(fieldShape).min(1),
        subjectId: z.string().optional().describe("Record the route and facts under this id."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      let client: CalleClient;
      try {
        client = makeClient();
      } catch (error) {
        return failure({ error: redactError(error) });
      }

      try {
        const call = await client.calls.get(args.callId);
        const turns: CallTranscriptTurn[] = call.recipients.flatMap((recipient) =>
          recipient.attempts.flatMap((attempt) => attempt.transcriptTurns as CallTranscriptTurn[]),
        );
        const probes = probesFrom(args.fields);
        const gate = runEvidenceGate({
          structuredResult: call.structuredResult,
          transcriptTurns: turns,
          probes,
          completionConfidence: call.completionConfidence,
        });

        let holdSeconds: number | null = null;
        if (args.subjectId) {
          const observation = observeRoute({
            subjectId: args.subjectId,
            callId: call.id,
            turns,
          });
          if (observation) {
            routes.record(observation);
            holdSeconds = observation.reachedHumanAtSeconds;
          }
          facts.record({
            subjectId: args.subjectId,
            callId: call.id,
            gate,
            result: call.structuredResult,
            confidence: call.completionConfidence?.score ?? 0,
          });
        }

        return reply({
          callId: call.id,
          status: call.status,
          verdict: gate.verdict,
          result: gatedResult(gate, call.structuredResult),
          fields: gate.fields.map((f) => ({
            field: f.field,
            verdict: f.verdict,
            supportingTurn: f.supportingTurn,
            note: f.note,
          })),
          unsupportedFields: gate.unsupportedFields,
          reasons: gate.reasons,
          secondsOnHold: holdSeconds,
          note: "Fields the transcript does not support are null, whatever the model reported.",
        });
      } catch (error) {
        return failure({ error: redactError(error), classification: classifyFailure(error) });
      }
    },
  );

  return server;
}

/** Entry point for `npm run mcp`. */
export async function main(): Promise<void> {
  const server = createServer();
  await server.connect(new StdioServerTransport());
}
