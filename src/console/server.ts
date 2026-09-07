/**
 * The HOLDLINE console.
 *
 * A small HTTP server over the same engine the MCP tools use. No framework and
 * no build step: one static page and three JSON endpoints, so the thing a
 * reviewer runs is the thing that is written down here.
 *
 * It defaults to simulation. Placing real calls needs `CALLE_API_KEY` in the
 * environment *and* `HOLDLINE_CONSOLE_LIVE=1`, and even then every run body
 * must carry `confirm: true`. The page cannot dial by itself.
 *
 * Binds to loopback. This serves an operations view over call transcripts and
 * has no authentication of its own; it is not something to expose.
 */

import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { CalleClient } from "@call-e/calle";

import { redact, redactError } from "../core/redact.js";
import { classifyFailure } from "../core/outcome.js";
import { IdempotencyLedger } from "../core/idempotency.js";
import { checkPhone } from "../core/phone.js";
import { planQueue, runQueue, type QueueRequest, type QueueTarget } from "../engine/queue.js";
import type { CallTranscriptTurn, FieldProbe } from "../evidence/types.js";
import { FactLedger } from "../ledger/facts.js";
import { RouteCache, observeRoute } from "../ledger/routes.js";
import { SCENARIOS, createFakeCalle, type Scenario } from "../testing/fake-calle.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE = readFileSync(join(HERE, "index.html"), "utf8");

export interface ConsoleOptions {
  /** Force simulation regardless of environment. Defaults to true unless live is enabled. */
  readonly simulate?: boolean;
  /**
   * How much faster than real time a timeline plays back. Defaults to
   * `PLAYBACK_SPEED`; tests raise it so the suite does not sit through the
   * hold music.
   */
  readonly playbackSpeed?: number;
  /** Scenario the fake transport plays. Defaults to `ivr_traversal`. */
  readonly scenario?: Scenario;
}

interface WireField {
  name: string;
  asks: string[];
  required?: boolean;
}

interface WireBody {
  goal?: string;
  routingHint?: string;
  workflow?: string;
  intent?: string;
  batchId?: string;
  targets?: QueueTarget[];
  fields?: WireField[];
  confirm?: boolean;
  scenario?: string;
}

const liveEnabled = (): boolean =>
  process.env["HOLDLINE_CONSOLE_LIVE"] === "1" && Boolean(process.env["CALLE_API_KEY"]);

function badRequest(body: WireBody): string | null {
  if (!body.goal?.trim()) return "goal is required";
  if (!Array.isArray(body.targets) || body.targets.length === 0) return "at least one target is required";
  if (!Array.isArray(body.fields) || body.fields.length === 0) return "at least one field is required";
  for (const field of body.fields) {
    if (!field?.name?.trim()) return "every field needs a name";
    if (!Array.isArray(field.asks) || field.asks.length === 0) {
      return `field ${field.name} needs at least one ask phrase`;
    }
  }
  if (!body.batchId?.trim()) return "batchId is required and must be a stable record id";
  return null;
}

const probesFrom = (fields: readonly WireField[]): FieldProbe[] =>
  fields.map((field) => ({ field: field.name, required: field.required ?? true, asks: field.asks }));

const requestFrom = (body: WireBody, mode: "preview" | "live"): QueueRequest => ({
  workflow: body.workflow?.trim() || "console",
  intent: body.intent?.trim() || "ask",
  batchId: body.batchId!.trim(),
  goal: body.goal!.trim(),
  ...(body.routingHint?.trim() ? { routingHint: body.routingHint.trim() } : {}),
  targets: body.targets!,
  probes: probesFrom(body.fields!),
  recipientResultSchema: {
    type: "object",
    properties: Object.fromEntries(body.fields!.map((f) => [f.name, { type: "string" }])),
    required: body.fields!.filter((f) => f.required ?? true).map((f) => f.name),
  },
  mode,
});

/**
 * Build a simulation that follows the batch the operator actually submitted.
 *
 * One recipient per target, and the transcripts alternate on purpose: the
 * even-indexed places are asked every question, the odd-indexed ones are asked
 * only the first while the result comes back fully populated anyway. That is
 * CALL-E issue #316 reproduced, and putting the two side by side in one batch
 * is the whole point of the console — a verified answer and a withheld one,
 * from the same dispatch, with the reason shown.
 */
function simulationFor(targets: readonly QueueTarget[], fields: readonly WireField[]): Scenario {
  const result = Object.fromEntries(fields.map((f) => [f.name, "yes"]));
  // Only dialable targets become recipients, because only those are sent. A
  // simulation that answers for a number the plan refused would invent a
  // recipient the real API never returns.
  const dialable = targets.filter((target) => checkPhone(target.phone).ok);

  return {
    pollsUntilTerminal: 1,
    finalStatus: "completed",
    taskCompleted: true,
    completionConfidence: { score: 0.91, label: "high" },
    evidence: ["Simulated evidence. No telephone was involved."],
    structuredResult: result,
    recipients: dialable.map((target, index) => {
      const complete = index % 2 === 0;
      const asked = complete ? fields : fields.slice(0, 1);
      const turns = [
        { offset_seconds: 3, speaker: "unknown" as const, text: "Please listen carefully. For reception press 1." },
        { offset_seconds: 9, speaker: "bot" as const, text: "Selecting reception." },
        { offset_seconds: 14, speaker: "unknown" as const, text: "All of our representatives are busy. Please hold." },
        { offset_seconds: 132, speaker: "user" as const, text: "Front desk, how can I help?" },
        {
          offset_seconds: 136,
          speaker: "bot" as const,
          text: "Hello, I am an automated assistant calling on behalf of a patient.",
        },
      ];
      for (const [i, field] of asked.entries()) {
        turns.push({
          offset_seconds: 142 + i * 12,
          speaker: "bot" as const,
          text: `Can I ask, ${field.asks[0]}?`,
        });
        turns.push({ offset_seconds: 148 + i * 12, speaker: "user" as const, text: "Yes, that's right." });
      }
      if (!complete) {
        turns.push({ offset_seconds: 170, speaker: "bot" as const, text: "Thank you for your time. Goodbye." });
      }

      return { phone: target.phone, transcript: turns, structuredResult: result };
    }),
  };
}


/**
 * Turn one recipient's transcript into a timeline the console can play back.
 *
 * The events carry the offset from the transcript itself, so the clock on
 * screen is the call's own clock — a 132-second hold reads as 2:12 even though
 * the playback takes a few seconds. The speed-up is stated in the stream and
 * shown in the interface; nothing here invents a duration.
 *
 * In live mode there is no transcript until the call ends, so the timeline is
 * emitted after the fact. It is a replay of what happened, not a live feed, and
 * it says so.
 */
function timelineFor(turns: readonly CallTranscriptTurn[]): TimelineStep[] {
  const steps: TimelineStep[] = [];
  let reachedPerson = false;

  for (const turn of turns) {
    const at = turn.offset_seconds ?? 0;
    const text = turn.text.toLowerCase();

    if (turn.speaker === "user" && !reachedPerson) {
      reachedPerson = true;
      steps.push({ at, phase: "answered", detail: "a person answered" });
      continue;
    }
    if (!reachedPerson && turn.speaker === "unknown") {
      const holding = /hold|representatives are|queue|wait/.test(text);
      steps.push({
        at,
        phase: holding ? "holding" : "menu",
        detail: holding ? "waiting in the queue" : "listening to the menu",
      });
      continue;
    }
    if (!reachedPerson && turn.speaker === "bot") {
      steps.push({ at, phase: "menu", detail: turn.text });
      continue;
    }
    if (reachedPerson && turn.speaker === "bot" && turn.text.includes("?")) {
      steps.push({ at, phase: "asking", detail: turn.text });
    }
  }
  return steps;
}

export interface TimelineStep {
  /** Seconds from the start of the call, taken from the transcript. */
  readonly at: number;
  readonly phase: "queued" | "menu" | "holding" | "answered" | "asking";
  readonly detail: string;
}

/** How much faster than real time the console plays a timeline back. */
export const PLAYBACK_SPEED = 25;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createConsole(options: ConsoleOptions = {}): Server {
  const facts = new FactLedger();
  const routes = new RouteCache();
  const idempotency = new IdempotencyLedger();

  const simulate = options.simulate ?? !liveEnabled();
  const playbackSpeed = options.playbackSpeed ?? PLAYBACK_SPEED;

  // One fake transport for the life of the console, not one per request.
  // A real API remembers the calls it created; replaying an idempotency key
  // has to find the earlier call, and a per-request fake would lose it.
  let currentScenario: Scenario = SCENARIOS.ivr_traversal;
  const fake = createFakeCalle({ scenarioFor: () => currentScenario });
  const simulatedClient = new CalleClient({ apiKey: "simulated", fetch: fake.fetch });

  const clientFor = (body: WireBody): CalleClient => {
    if (simulate) {
      currentScenario =
        options.scenario ??
        (body.scenario && body.scenario in SCENARIOS
          ? SCENARIOS[body.scenario as keyof typeof SCENARIOS]
          : simulationFor(body.targets!, body.fields!));
      return simulatedClient;
    }
    return new CalleClient({ apiKey: process.env["CALLE_API_KEY"]! });
  };

  const send = (res: ServerResponse, status: number, payload: unknown): void => {
    const body = JSON.stringify(redact({ simulated: simulate, ...(payload as object) }), null, 2);
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(body);
  };

  const readBody = async (req: IncomingMessage): Promise<WireBody> => {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > 256 * 1024) throw new Error("Request body too large.");
      chunks.push(chunk as Buffer);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as WireBody;
  };

  return createHttpServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");

      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
          "X-Content-Type-Options": "nosniff",
        });
        res.end(PAGE);
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/state") {
        send(res, 200, {
          mode: simulate ? "simulation" : "live",
          liveAvailable: liveEnabled(),
          ledger: facts.stats(),
          routesKnown: routes.size,
          secondsAbsorbed: routes.totalHoldSeconds(),
          scenarios: Object.keys(SCENARIOS),
        });
        return;
      }

      if (req.method === "POST" && (url.pathname === "/api/plan" || url.pathname === "/api/run")) {
        let body: WireBody;
        try {
          body = await readBody(req);
        } catch (error) {
          send(res, 400, { error: redactError(error) });
          return;
        }

        const invalid = badRequest(body);
        if (invalid) {
          send(res, 400, { error: invalid });
          return;
        }

        if (url.pathname === "/api/plan") {
          try {
            const plan = planQueue(requestFrom(body, "preview"));
            send(res, 200, {
              task: plan.task.task,
              used: plan.task.used,
              budget: plan.task.budget,
              dropped: plan.task.dropped,
              idempotencyKey: plan.idempotencyKey,
              dialable: plan.dialable.map((t) => ({
                subjectId: t.subjectId,
                label: t.label ?? null,
                phone: t.phone,
                routeHint: routes.hintFor(t.subjectId),
              })),
              rejected: plan.rejected,
              note: "Nothing was dialed.",
            });
          } catch (error) {
            send(res, 400, { error: redactError(error) });
          }
          return;
        }

        if (body.confirm !== true) {
          send(res, 400, {
            refused: "confirm was not true",
            note: "Placing calls requires an explicit confirmation in the same request.",
          });
          return;
        }

        if (!simulate && !liveEnabled()) {
          send(res, 400, {
            error:
              "Live mode is not enabled. Set CALLE_API_KEY and HOLDLINE_CONSOLE_LIVE=1, or run the console in simulation.",
          });
          return;
        }

        try {
          const outcome = await runQueue(requestFrom(body, "live"), {
            client: clientFor(body),
            ledger: idempotency,
            intervalMs: 40,
            timeoutMs: 60_000,
          });

          if (outcome.kind === "unresolved") {
            send(res, 200, {
              outcome: "unresolved",
              callId: outcome.callId,
              classification: outcome.classification,
              note: "Not retried. An unknown outcome is reconciled, never re-dialed.",
            });
            return;
          }
          if (outcome.kind === "preview") {
            send(res, 200, { outcome: "preview", task: outcome.plan.task.task });
            return;
          }

          // Record what the batch taught us, exactly as the MCP path does.
          for (const target of outcome.targets) {
            facts.record({
              subjectId: target.subjectId,
              callId: outcome.callId,
              gate: target.gate,
              result: target.result,
              confidence: 1,
            });
            const observation = observeRoute({
              subjectId: target.subjectId,
              callId: outcome.callId,
              turns: target.transcript,
            });
            if (observation) routes.record(observation);
          }
          const absorbed = routes.totalHoldSeconds();

          send(res, 200, {
            outcome: "completed",
            callId: outcome.callId,
            replayed: outcome.replayed,
            secondsAbsorbed: absorbed,
            targets: outcome.targets.map((target) => ({
              subjectId: target.subjectId,
              label: target.label ?? null,
              phone: target.maskedPhone,
              verdict: target.gate.verdict,
              result: target.result,
              unsupportedFields: target.gate.unsupportedFields,
              reasons: target.gate.reasons,
              fields: target.gate.fields.map((f) => ({
                field: f.field,
                verdict: f.verdict,
                supportingTurn: f.supportingTurn,
                note: f.note,
              })),
            })),
          });
        } catch (error) {
          send(res, 500, { error: redactError(error), classification: classifyFailure(error) });
        }
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/run-stream") {
        let body: WireBody;
        try {
          body = await readBody(req);
        } catch (error) {
          send(res, 400, { error: redactError(error) });
          return;
        }

        const invalid = badRequest(body);
        if (invalid) {
          send(res, 400, { error: invalid });
          return;
        }
        if (body.confirm !== true) {
          send(res, 400, { refused: "confirm was not true" });
          return;
        }
        if (!simulate && !liveEnabled()) {
          send(res, 400, { error: "Live mode is not enabled." });
          return;
        }

        // Newline-delimited JSON rather than server-sent events: the request
        // is a POST carrying the batch, and EventSource cannot do POST.
        res.writeHead(200, {
          "Content-Type": "application/x-ndjson; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        });
        const emit = (event: Record<string, unknown>): void => {
          res.write(`${JSON.stringify(redact({ simulated: simulate, ...event }))}
`);
        };

        try {
          const plan = planQueue(requestFrom(body, "live"));
          emit({
            type: "plan",
            task: plan.task.task,
            used: plan.task.used,
            budget: plan.task.budget,
            idempotencyKey: plan.idempotencyKey,
            dialable: plan.dialable.map((t) => ({
              subjectId: t.subjectId,
              label: t.label ?? null,
              phone: t.phone,
            })),
            rejected: plan.rejected,
            playbackSpeed,
            note: "The clock on each row is the call's own clock, replayed from the transcript.",
          });

          for (const target of plan.dialable) {
            emit({ type: "phase", subjectId: target.subjectId, at: 0, phase: "queued", detail: "waiting to dial" });
          }

          const outcome = await runQueue(requestFrom(body, "live"), {
            client: clientFor(body),
            ledger: idempotency,
            intervalMs: 40,
            timeoutMs: 60_000,
          });

          if (outcome.kind !== "completed") {
            emit({
              type: "unresolved",
              callId: outcome.kind === "unresolved" ? outcome.callId : null,
              classification: outcome.kind === "unresolved" ? outcome.classification : null,
              note: "Not retried. An unknown outcome is reconciled, never re-dialed.",
            });
            res.end();
            return;
          }

          // Play every target's timeline together, ordered by call time, so the
          // rows advance the way the calls actually ran: in parallel.
          const queue = outcome.targets.flatMap((target) =>
            timelineFor(target.transcript).map((step) => ({ target, step })),
          );
          queue.sort((a, b) => a.step.at - b.step.at);

          // Ticks while a call is holding, in call-seconds. Without these the
          // clock freezes at the moment the queue was entered and jumps to the
          // moment somebody answered — which hides the only thing worth
          // watching. The wait is the product; it has to be visible.
          const HOLD_TICK_SECONDS = 8;
          const holding = new Map<string, number>();

          let played = 0;
          for (const { target, step } of queue) {
            // Advance the clock in small steps so anything on hold keeps
            // counting up while we wait for the next real event.
            while (holding.size > 0 && step.at - played > HOLD_TICK_SECONDS) {
              played += HOLD_TICK_SECONDS;
              await sleep((HOLD_TICK_SECONDS * 1000) / playbackSpeed);
              for (const [subjectId, since] of holding) {
                emit({
                  type: "phase",
                  subjectId,
                  at: played,
                  phase: "holding",
                  detail: `on hold for ${Math.round(played - since)}s`,
                });
              }
            }

            const waitMs = Math.max(0, ((step.at - played) * 1000) / playbackSpeed);
            if (waitMs > 0) await sleep(Math.min(waitMs, 2500));
            played = Math.max(played, step.at);

            if (step.phase === "holding") holding.set(target.subjectId, step.at);
            else holding.delete(target.subjectId);

            emit({
              type: "phase",
              subjectId: target.subjectId,
              at: step.at,
              phase: step.phase,
              detail: step.detail,
            });
          }

          for (const target of outcome.targets) {
            facts.record({
              subjectId: target.subjectId,
              callId: outcome.callId,
              gate: target.gate,
              result: target.result,
              confidence: 1,
            });
            const observation = observeRoute({
              subjectId: target.subjectId,
              callId: outcome.callId,
              turns: target.transcript,
            });
            if (observation) routes.record(observation);

            emit({
              type: "verdict",
              subjectId: target.subjectId,
              label: target.label ?? null,
              phone: target.maskedPhone,
              verdict: target.gate.verdict,
              result: target.result,
              unsupportedFields: target.gate.unsupportedFields,
              reasons: target.gate.reasons,
              fields: target.gate.fields.map((f) => ({
                field: f.field,
                verdict: f.verdict,
                supportingTurn: f.supportingTurn,
                note: f.note,
              })),
            });
          }

          emit({
            type: "done",
            callId: outcome.callId,
            replayed: outcome.replayed,
            secondsAbsorbed: routes.totalHoldSeconds(),
          });
        } catch (error) {
          emit({ type: "error", error: redactError(error), classification: classifyFailure(error) });
        }
        res.end();
        return;
      }

      send(res, 404, { error: "Not found." });
    })().catch((error: unknown) => {
      send(res, 500, { error: redactError(error) });
    });
  });
}

/** Observe a route from a completed call. Exported for the run script. */
export { observeRoute };
