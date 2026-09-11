/**
 * `npm run probe:fanout` — does a multi-recipient call return transcript turns?
 *
 * This exists because the answer turned out to be no, and because a finding
 * nobody else can reproduce is an anecdote. It runs both arms of the same
 * experiment back to back, against the same numbers, from the same account,
 * minutes apart:
 *
 *   A. one call task carrying every recipient   (the documented batch shape)
 *   B. one call task per recipient              (what this engine does now)
 *
 * and prints the transcript turn count each arm came back with. That is the
 * whole measurement. Nothing else about the calls is kept: no transcript, no
 * call id, no structured result — the counts are the finding, and a file that
 * holds only counts is a file nobody has to purge later.
 *
 *   npm run probe:fanout -- --to +1... --to +1... --to +1...
 *   npm run probe:fanout -- --to +1... --to +1... --to +1... --live
 *
 * Preview by default. `--live` places 2N real calls, N per arm, and only after
 * LIVE is typed at the prompt.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import { CalleClient, type Call } from "@call-e/calle";

import { checkPhone, maskPhone } from "../core/phone.js";
import { regionForNumber } from "../core/regions.js";
import { redactError } from "../core/redact.js";
import { classifyFailure } from "../core/outcome.js";

const OUTPUT_DIR = "probe-output";
// Deliberately generic. This probe counts transcript turns; it does not care
// what the line says back, and naming the organisation we happened to dial
// would both identify it and make the default nonsense for anyone pointing
// `--to` somewhere else.
const TASK = "Ask what this line can help with. Say you are an automated assistant when a person answers.";

interface Args {
  readonly to: string[];
  readonly task: string;
  readonly live: boolean;
}

function parseArgs(argv: string[]): Args {
  const to: string[] = [];
  let task = TASK;
  let live = false;

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = argv[i + 1];
    if (flag === "--live") live = true;
    else if (flag === "--to" && next) {
      to.push(next);
      i += 1;
    } else if (flag === "--task" && next) {
      task = next;
      i += 1;
    }
  }

  return { to, task, live };
}

/** Transcript turns for each recipient of a settled call, in recipient order. */
function turnCounts(call: Call): number[] {
  return call.recipients.map((recipient) =>
    recipient.attempts.reduce((total, attempt) => total + (attempt.transcriptTurns?.length ?? 0), 0),
  );
}

async function confirm(count: number): Promise<boolean> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    stdout.write(`\n  This places ${count} real phone calls, billed — ${count / 2} per arm, to the same numbers twice.\n`);
    const answer = await rl.question("\n  Type LIVE to place them, anything else to abort: ");
    return answer.trim() === "LIVE";
  } finally {
    rl.close();
  }
}

const pad = (text: string, width: number) => text.padEnd(width);

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  if (args.to.length < 2) {
    stdout.write("\n  At least two --to numbers are required; the finding is about several recipients.\n\n");
    return 2;
  }

  for (const phone of args.to) {
    const check = checkPhone(phone);
    if (!check.ok) {
      stdout.write(`\n  ${maskPhone(phone)} refused: ${check.reason}\n\n`);
      return 2;
    }
    if (regionForNumber(phone) === null) {
      stdout.write(`\n  ${maskPhone(phone)} is in a region CALL-E does not serve.\n\n`);
      return 2;
    }
  }

  stdout.write("\n  Arm A   one call task, every recipient on it\n");
  stdout.write("  Arm B   one call task per recipient\n\n");
  for (const phone of args.to) stdout.write(`  will dial   ${maskPhone(phone)}   (once per arm)\n`);
  stdout.write(`\n  "${args.task}"\n`);

  if (!args.live) {
    stdout.write("\n  Plan only. Nothing was dialed. Add --live to run both arms.\n\n");
    return 0;
  }

  const apiKey = process.env["CALLE_API_KEY"];
  if (!apiKey) {
    stdout.write("\n  CALLE_API_KEY is not set.\n\n");
    return 2;
  }
  if (!(await confirm(args.to.length * 2))) {
    stdout.write("\n  Aborted. Nothing was dialed.\n\n");
    return 1;
  }

  const client = new CalleClient({ apiKey });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");

  // Arm A — the documented batch shape.
  stdout.write("\n  Arm A dialing. This blocks until every recipient settles.\n");
  const createdA = await client.calls.create({
    task: args.task,
    recipients: args.to.map((phone) => ({ phone })),
    metadata: { holdline_probe: "fanout-transcripts", holdline_arm: "A" },
  });
  const settledA = await client.calls.waitForResult(createdA.id);
  const armA = turnCounts(settledA);

  // Arm B — one recipient per call, dispatched together.
  stdout.write("  Arm B dialing.\n");
  const settledB = await Promise.all(
    args.to.map(async (phone) => {
      const created = await client.calls.create({
        task: args.task,
        recipients: [{ phone }],
        metadata: { holdline_probe: "fanout-transcripts", holdline_arm: "B" },
      });
      return client.calls.waitForResult(created.id);
    }),
  );
  const armB = settledB.map((call) => turnCounts(call)[0] ?? 0);

  stdout.write("\n  transcript turns returned\n\n");
  stdout.write(`  ${pad("", 14)} ${pad("arm A", 10)} arm B\n`);
  stdout.write(`  ${pad("", 14)} ${pad("(one call)", 10)} (a call each)\n`);
  for (const [index, phone] of args.to.entries()) {
    stdout.write(`  ${pad(maskPhone(phone), 14)} ${pad(String(armA[index] ?? 0), 10)} ${armB[index] ?? 0}\n`);
  }

  const anyA = armA.some((count) => count > 0);
  const anyB = armB.some((count) => count > 0);
  stdout.write(
    anyB && !anyA
      ? "\n  Reproduced: turns came back one recipient at a time and not all at once.\n"
      : "\n  Not reproduced on this run. Both arms are shown above; report what you saw.\n",
  );

  // Counts only. No transcript, no call id, no structured result — there is
  // nothing here that would ever have to be scrubbed out of a public history.
  await mkdir(OUTPUT_DIR, { recursive: true });
  const file = path.join(OUTPUT_DIR, `fanout-transcripts-${stamp}.json`);
  await writeFile(
    file,
    `${JSON.stringify(
      {
        probe: "fanout-transcripts",
        recipients: args.to.map((phone) => maskPhone(phone)),
        turnsArmA: armA,
        turnsArmB: armB,
        reproduced: anyB && !anyA,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  stdout.write(`\n  counts only, safe to share   ${file}\n\n`);

  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    stdout.write(`\n${JSON.stringify(redactError(error), null, 2)}\n`);
    stdout.write(`classification  ${classifyFailure(error).class}\n\n`);
    process.exit(3);
  });
