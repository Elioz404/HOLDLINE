/**
 * `npm run call` — the product, from a terminal.
 *
 * Everything else here approaches the engine from the side: the console drives
 * it over HTTP, the MCP server exposes it to an agent, and the probe is a
 * diagnostic that asks about the call rather than about anything a person
 * needs to know. This is the plain entry point — one question, several places,
 * one batch, and only the answers the calls established.
 *
 *   npm run call -- --ask "Are you open on Saturday?" \
 *                   --to +1... --to +1... \
 *                   --field open_saturday="open on saturday,saturday hours"
 *
 * It plans and stops. `--live` places the calls, and only after LIVE is typed
 * at the prompt. One call is billed per dialable number.
 *
 * Write `--field` asks after the words the agent will say, not after the field
 * name; `skills/holdline/references/probes.md` explains why. The gate prints
 * the questions no probe claimed, so a second run can do better without
 * dialing anyone a second time.
 */

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import { CalleClient } from "@call-e/calle";

import { maskPhone } from "../core/phone.js";
import { regionForNumber } from "../core/regions.js";
import { redact, redactError } from "../core/redact.js";
import { classifyFailure } from "../core/outcome.js";
import { runQueue, type QueueRequest, type QueueTarget } from "../engine/queue.js";
import type { FieldProbe } from "../evidence/types.js";

const OUTPUT_DIR = "probe-output";

interface Args {
  ask: string | null;
  to: string[];
  fields: FieldProbe[];
  routingHint: string | null;
  batchId: string | null;
  live: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { ask: null, to: [], fields: [], routingHint: null, batchId: null, live: false };

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = argv[i + 1];
    if (flag === "--live") {
      args.live = true;
    } else if (flag === "--ask" && next) {
      args.ask = next;
      i += 1;
    } else if (flag === "--to" && next) {
      args.to.push(next);
      i += 1;
    } else if (flag === "--routing" && next) {
      args.routingHint = next;
      i += 1;
    } else if (flag === "--batch" && next) {
      args.batchId = next;
      i += 1;
    } else if (flag === "--field" && next) {
      const split = next.indexOf("=");
      if (split < 1) throw new Error(`--field ${next} is not name=asks.`);
      const asks = next
        .slice(split + 1)
        .split(",")
        .map((ask) => ask.trim())
        .filter(Boolean);
      if (asks.length === 0) throw new Error(`--field ${next.slice(0, split)} lists no asks.`);
      args.fields.push({ field: next.slice(0, split), required: true, asks });
      i += 1;
    }
  }

  return args;
}

async function confirmLive(numbers: readonly string[]): Promise<boolean> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    stdout.write(`\n  This places ${numbers.length} real phone call${numbers.length === 1 ? "" : "s"}, billed, to:\n`);
    for (const number of numbers) stdout.write(`    ${maskPhone(number)}\n`);
    const answer = await rl.question("\n  Type LIVE to place them, anything else to abort: ");
    return answer.trim() === "LIVE";
  } finally {
    rl.close();
  }
}

const pad = (text: string, width: number) => text.padEnd(width);

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  if (!args.ask) {
    stdout.write('\n  --ask "the question" is required.\n\n');
    return 2;
  }
  if (args.to.length === 0) {
    stdout.write("\n  At least one --to is required.\n\n");
    return 2;
  }
  if (args.fields.length === 0) {
    stdout.write('\n  At least one --field name="ask,ask" is required. Nothing can be verified without one.\n\n');
    return 2;
  }

  // The batch id is the authorizing record and the idempotency key is derived
  // from it. Absent one, derive a stable id from the question and the numbers,
  // so re-running the identical request is a replay rather than a second round
  // of ringing. Never the clock.
  const batchId =
    args.batchId ??
    `cli-${createHash("sha256")
      .update(`${args.ask}|${[...args.to].sort().join(",")}`, "utf8")
      .digest("hex")
      .slice(0, 12)}`;

  const targets: QueueTarget[] = args.to.map((phone, index) => ({
    subjectId: `target-${index + 1}`,
    phone,
    label: `target ${index + 1}`,
  }));

  const request: QueueRequest = {
    workflow: "holdline",
    intent: "ask",
    batchId,
    goal: args.ask,
    ...(args.routingHint ? { routingHint: args.routingHint } : {}),
    targets,
    probes: args.fields,
    recipientResultSchema: {
      type: "object",
      // The API passes `description` to the extraction model and says so:
      // "Descriptions guide extraction but are not hard validation rules."
      // The asks are already the words we expect to hear the topic in, so they
      // are the best description available, and `unknown` is offered because
      // the docs ask for a value the model can pick when the call did not
      // establish one. A model that has somewhere honest to put "I did not
      // hear this" is less likely to invent a value — and the gate withholds
      // `unknown` anyway, so this cannot manufacture a verified field.
      properties: Object.fromEntries(
        args.fields.map((field) => [
          field.field,
          {
            type: "string",
            description: `The answer the call established about: ${field.asks
              .filter((ask): ask is string => typeof ask === "string")
              .join(", ")}. Answer "unknown" if the call did not establish it.`,
          },
        ]),
      ),
      required: args.fields.map((field) => field.field),
    },
    mode: args.live ? "live" : "preview",
  };

  // Plan first, always, whether or not this run will dial. The client here is
  // never used: a preview does not reach the network.
  const planned = await runQueue({ ...request, mode: "preview" }, { client: new CalleClient({ apiKey: "unused" }) });
  if (planned.kind !== "preview") throw new Error("Preview did not return a plan.");
  const { plan } = planned;

  stdout.write(`\n  Task compiled     ${plan.task.used}/${plan.task.budget} characters\n`);
  if (plan.task.dropped.length > 0) stdout.write(`  Dropped segments  ${plan.task.dropped.join(", ")}\n`);
  // The batch key. Each target derives its own from this same authorizing
  // record plus its subject id, so one target can be reconciled without
  // risking a second call to the others.
  stdout.write(`  Batch key         ${plan.idempotencyKey}  (each target derives its own)\n`);
  stdout.write(`  Batch id          ${batchId}\n\n`);
  stdout.write(`  "${plan.task.task}"\n\n`);

  for (const target of plan.dialable) {
    const region = regionForNumber(target.phone);
    stdout.write(
      `  will dial   ${pad(maskPhone(target.phone), 18)} ${region ? region.country : "REGION NOT SUPPORTED"}\n`,
    );
  }
  for (const rejected of plan.rejected) {
    stdout.write(`  refused     ${pad(rejected.maskedPhone, 18)} ${rejected.reason}\n`);
  }

  // A number CALL-E does not serve is refused here, rather than discovered as
  // a 422 after the dispatch has already been accepted for the others.
  if (plan.dialable.some((target) => regionForNumber(target.phone) === null)) {
    stdout.write("\n  Refusing to dispatch: CALL-E does not serve every number above.\n\n");
    return 2;
  }

  if (!args.live) {
    stdout.write("\n  Plan only. Nothing was dialed. Add --live to place these calls.\n\n");
    return 0;
  }

  const apiKey = process.env["CALLE_API_KEY"];
  if (!apiKey) {
    stdout.write("\n  CALLE_API_KEY is not set. Copy .env.example to .env and fill it in.\n\n");
    return 2;
  }

  if (!(await confirmLive(plan.dialable.map((target) => target.phone)))) {
    stdout.write("\n  Aborted. Nothing was dialed.\n\n");
    return 1;
  }

  stdout.write("\n  Dialing. This blocks until every recipient settles.\n");

  const client = new CalleClient({ apiKey });
  const outcome = await runQueue(request, { client, timeoutMs: 10 * 60 * 1000 });

  if (outcome.kind === "unresolved") {
    stdout.write("\n  Unresolved.\n");
    stdout.write(`  call id         ${outcome.callId ?? "(never created)"}\n`);
    stdout.write(`  classification  ${outcome.classification.class} (${outcome.classification.code})\n`);
    stdout.write(`  reason          ${outcome.classification.reason}\n`);
    if (outcome.callId) {
      stdout.write("\n  Do NOT re-run blindly. A timeout does not mean no call happened.\n");
      stdout.write(`  Reconcile that call id with get_verdict instead of dialing again.\n\n`);
    }
    return 3;
  }
  if (outcome.kind === "preview") return 0;

  stdout.write(
    `\n  call ids    ${outcome.callIds.join(", ")}${outcome.replayed ? "   (replayed — this intent had already gone out)" : ""}\n`,
  );

  // Fetch each call back. The outcome above is this engine's opinion of them;
  // the call objects are what the API actually said, and the two are worth
  // keeping side by side. The first live batch this tool placed came back with
  // every field withheld, and nothing in its own output explained why — the
  // answer was in the call object, which it had not kept. A GET costs nothing.
  //
  // One per target, because a batch is one call per target now. Indexing a
  // single call's recipients by target position stopped being meaningful.
  const settledByTarget = await Promise.all(
    outcome.targets.map(async (target) => (target.callId ? client.calls.get(target.callId) : null)),
  );

  for (const [index, target] of outcome.targets.entries()) {
    const settled = settledByTarget[index];
    stdout.write(`\n  ${target.label ?? target.subjectId}  ${target.maskedPhone}\n`);
    if (target.unresolved) {
      stdout.write(`    unresolved ${target.unresolved.class} — ${target.callId ?? "no call was created"}\n`);
      continue;
    }
    if (settled) {
      stdout.write(`    reported  ${settled.status}, taskCompleted ${String(settled.taskCompleted)}`);
      if (settled.completionConfidence) stdout.write(`, confidence ${settled.completionConfidence.score}`);
      stdout.write("\n");
    }
    const attempt = settled?.recipients[0]?.attempts[0];
    if (attempt?.startedAt && attempt.completedAt) {
      const seconds = Math.round((Date.parse(attempt.completedAt) - Date.parse(attempt.startedAt)) / 1000);
      stdout.write(`    on call   ${seconds}s, ${target.transcript.length} transcript turns\n`);
    }
    stdout.write(`    verdict   ${target.gate.verdict}\n`);
    for (const field of target.gate.fields) {
      stdout.write(`    ${pad(field.field, 22)} ${field.verdict}\n`);
      if (field.supportingTurn) stdout.write(`    ${pad("", 22)} "${field.supportingTurn}"\n`);
    }
    stdout.write(`    answers   ${JSON.stringify(target.result)}\n`);
    for (const reason of target.gate.reasons) stdout.write(`    withheld  ${reason}\n`);
    // The raw material for better probes, printed rather than buried.
    for (const question of target.gate.unclaimedQuestions) {
      stdout.write(`    unclaimed "${question}"\n`);
    }
  }

  // These transcripts are real conversations. The raw file is gitignored; the
  // masked one is the only file safe to paste anywhere.
  await mkdir(OUTPUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const record = {
    callIds: outcome.callIds,
    batchId,
    task: plan.task.task,
    idempotencyKey: plan.idempotencyKey,
    // What the API said, then what this engine made of it. Keeping only the
    // second leaves a failure undiagnosable.
    // One call per target now, so the record keeps all of them.
    calls: settledByTarget,
    targets: outcome.targets,
  };
  const raw = path.join(OUTPUT_DIR, `call-${stamp}.raw.json`);
  const masked = path.join(OUTPUT_DIR, `call-${stamp}.masked.json`);
  await writeFile(raw, JSON.stringify(record, null, 2), "utf8");
  await writeFile(masked, JSON.stringify(redact(record), null, 2), "utf8");
  stdout.write(`\n  raw (private)      ${raw}\n`);
  stdout.write(`  masked (shareable) ${masked}\n\n`);

  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    stdout.write(`\n${JSON.stringify(redactError(error), null, 2)}\n`);
    stdout.write(`classification  ${classifyFailure(error).class}\n\n`);
    process.exit(3);
  });
