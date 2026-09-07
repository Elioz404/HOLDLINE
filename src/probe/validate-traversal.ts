/**
 * Day-1 decision gate: does CALL-E actually get through a phone tree?
 *
 * Two projects in the hackathon repository touch IVR traversal. Both are open
 * and unreviewed, so neither is evidence that it works. This script settles the
 * question with one real call before the remaining seven days of architecture
 * are built on top of the assumption.
 *
 * It answers three things and writes them down:
 *   1. Did the call connect at all, and how long before the bot spoke?
 *      (CALL-E issue #295 reports 23 seconds of silence on a 45-second call.)
 *   2. Is there any evidence in the transcript of menu navigation?
 *   3. Does the Evidence Gate agree that the question was actually asked?
 *
 * Default mode places no call. Live mode requires `--live` *and* typing LIVE at
 * the prompt; there is no flag that skips the prompt, because a flag that skips
 * a safety gate is the same as not having one.
 *
 * Usage
 *   npm run probe -- --check            confirm the credentials, place no call
 *   npm run probe                       plan only, prints the compiled task
 *   npm run probe -- --fixture <path>   replay a saved run, no network
 *   npm run probe -- --live             place one real call after confirmation
 *   npm run probe -- --live --menu-only  walk a public phone tree without
 *                                        queueing for a person
 */

import { createHash } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { mkdir, writeFile } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { stdin, stdout } from "node:process";
import path from "node:path";

import { CalleAPIError, CalleClient, type Call } from "@call-e/calle";

import { checkPhone, maskPhone } from "../core/phone.js";
import { regionForNumber, regionsSpeaking } from "../core/regions.js";
import { observeRoute, soundsAutomated } from "../ledger/routes.js";
import { redact, redactError } from "../core/redact.js";
import { classifyFailure } from "../core/outcome.js";
import { deriveIdempotencyKey } from "../core/idempotency.js";
import { compileTask, type TaskSegment } from "../core/task-compiler.js";
import { runEvidenceGate } from "../evidence/gate.js";
import type { CallTranscriptTurn, FieldProbe } from "../evidence/types.js";

const OUTPUT_DIR = "probe-output";

/** Words a phone menu says. Used only to look for traversal in a transcript. */
const MENU_MARKERS = [
  "press",
  "for english",
  "para español",
  "main menu",
  "please hold",
  "your call is important",
  "all of our representatives",
  "please listen carefully",
  "menu options",
  "to speak with",
];

/**
 * Probes for the probe's own result fields.
 *
 * The first version asked for `reached_human` with
 * `/hello|hi there|good morning|am i speaking/i`, which matched the agent's
 * own greeting — "Hello, can you hear me?" — and reported the field verified
 * on a call that reached no human at all. `references/probes.md` warns against
 * exactly that and I wrote it anyway.
 *
 * These now match the question, not the pleasantry, and both are optional:
 * a menu-only call is not supposed to establish either one, so requiring them
 * would fail every honest run.
 */
const PROBES: FieldProbe[] = [
  {
    field: "reached_human",
    required: false,
    asks: [/are you a (person|human)/i, /am i speaking (to|with) a (person|human)/i],
  },
  {
    field: "department_confirmed",
    required: false,
    asks: [/is this the .* (department|desk|team)/i, /have i reached/i],
  },
];

const RESULT_SCHEMA = {
  type: "object",
  required: ["reached_human", "department_confirmed"],
  properties: {
    reached_human: { type: "string", enum: ["yes", "no", "unknown"] },
    department_confirmed: { type: "string", enum: ["yes", "no", "unknown"] },
    menu_steps_taken: { type: "string" },
  },
} as const;

interface Args {
  live: boolean;
  check: boolean;
  menuOnly: boolean;
  locale: string | null;
  region: string | null;
  fixture: string | null;
  to: string | null;
  goal: string | null;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { live: false, check: false, menuOnly: false, locale: null, region: null, fixture: null, to: null, goal: null };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = argv[i + 1];
    if (flag === "--live") args.live = true;
    else if (flag === "--check") args.check = true;
    else if (flag === "--menu-only") args.menuOnly = true;
    else if (flag === "--fixture" && next) { args.fixture = next; i += 1; }
    else if (flag === "--to" && next) { args.to = next; i += 1; }
    else if (flag === "--goal" && next) { args.goal = next; i += 1; }
    else if (flag === "--locale" && next) { args.locale = next; i += 1; }
    else if (flag === "--region" && next) { args.region = next; i += 1; }
  }
  return args;
}

/**
 * Confirm the credentials work without spending a call.
 *
 * Fetching a call id that cannot exist costs nothing and tells us what we need:
 * a 401 means the key is wrong, a 404 means the key is fine and the id simply
 * is not there. Worth doing before someone types LIVE and burns one of twenty
 * free calls finding out their key is bad.
 */
async function checkCredentials(apiKey: string): Promise<number> {
  const client = new CalleClient({ apiKey });
  try {
    await client.calls.get("call_holdline_auth_probe_does_not_exist");
    console.log("Unexpected: that call id resolved. Credentials work.");
    return 0;
  } catch (error) {
    const classification = classifyFailure(error);
    const status = error instanceof CalleAPIError ? error.status : null;

    if (status === 404) {
      console.log("Credentials accepted. The API answered 404 for a call id that does not exist,");
      console.log("which is exactly right. No call was placed and nothing was billed.");
      return 0;
    }
    if (status === 401 || status === 403) {
      console.error("Credentials rejected. Check CALLE_API_KEY in .env.");
      console.error(JSON.stringify(redactError(error), null, 2));
      return 2;
    }
    console.error("Could not confirm credentials.");
    console.error(JSON.stringify(redactError(error), null, 2));
    console.error(`\nclassification  ${classification.class} (${classification.code})`);
    return 3;
  }
}

function buildTask(goal: string, menuOnly = false): ReturnType<typeof compileTask> {
  const segments: TaskSegment[] = [
    { label: "goal", text: goal, priority: "required" },
    {
      label: "routing",
      // Framed as what to do, not what to avoid. The first version said
      // "never queue for a person or ask for one"; the agent read that as
      // having nothing to ask for, announced it was not requesting help, and
      // hung up 5.6 seconds in, before the greeting had finished. A task is a
      // prompt, and a prompt made of prohibitions gets a refusal.
      // Positive framing, but the prohibition that keeps a stranger off the
      // line stays. Dropping it once was enough: on a real carrier call the
      // agent answered "yes, please connect me to a representative" three
      // times when the IVR offered. Rewriting for tone lost a safety rule.
      text: menuOnly
        ? "Listen first, then use the menu. Decline any offer of a representative."
        : "Navigate any phone menu to reach a live representative.",
      // In menu-only mode this carries the constraint that keeps a stranger
      // off the line, so it must not be the first thing dropped.
      priority: menuOnly ? "required" : "high",
    },
    {
      label: "disclosure",
      text: "Say you are an automated assistant when a person answers.",
      priority: "required",
    },
    { label: "brevity", text: "Keep it under two minutes.", priority: "low" },
  ];
  return compileTask(segments);
}

/** All transcript turns across every attempt of every recipient, oldest first. */
function allTurns(call: Call): CallTranscriptTurn[] {
  const turns: CallTranscriptTurn[] = [];
  for (const recipient of call.recipients) {
    for (const attempt of recipient.attempts) {
      turns.push(...(attempt.transcriptTurns as CallTranscriptTurn[]));
    }
  }
  return turns;
}

function firstBotOffset(turns: readonly CallTranscriptTurn[]): number | null {
  const first = turns.find((t) => t.speaker === "bot" && t.offset_seconds !== null);
  return first?.offset_seconds ?? null;
}

function menuEvidence(turns: readonly CallTranscriptTurn[]): string[] {
  const found: string[] = [];
  for (const t of turns) {
    const text = t.text.toLowerCase();
    for (const marker of MENU_MARKERS) {
      if (text.includes(marker) && !found.includes(marker)) found.push(marker);
    }
  }
  return found;
}

function report(call: Call): void {
  const turns = allTurns(call);
  const markers = menuEvidence(turns);
  const silence = firstBotOffset(turns);
  const route = observeRoute({ subjectId: "probe", callId: call.id, turns });

  const gate = runEvidenceGate({
    structuredResult: call.structuredResult,
    transcriptTurns: turns,
    probes: PROBES,
    completionConfidence: call.completionConfidence,
  });

  console.log("\n──────────── traversal probe ────────────");
  console.log(`call id            ${call.id}`);
  console.log(`status             ${call.status}`);
  console.log(`task completed     ${String(call.taskCompleted)}`);
  console.log(`confidence         ${call.completionConfidence?.score ?? "none"}`);
  console.log(`transcript turns   ${turns.length}`);
  console.log(`first bot speech   ${silence === null ? "unknown" : `${silence}s`}`);
  console.log(`menu markers       ${markers.length > 0 ? markers.join(", ") : "none found"}`);
  console.log(`evidence gate      ${gate.verdict}`);
  for (const reason of gate.reasons) console.log(`   · ${reason}`);

  // Three separate questions, because the first version collapsed them into
  // one and lied. It matched the word "press" anywhere in the transcript and
  // reported traversal on a call where the recording said "press 2" and the
  // agent pressed nothing.
  const menuHeard = turns.some((t) => t.speaker !== "bot" && soundsAutomated(t.text));
  const personAt = route?.firstNonSystemTurnAtSeconds ?? null;

  console.log("\n─────────────── verdict ────────────────");
  if (turns.length === 0) {
    console.log("INCONCLUSIVE — no transcript returned. Nothing can be judged.");
  } else {
    console.log(`menu heard         ${menuHeard ? "yes" : "no"}`);
    console.log(
      `used keypad        ${route?.usedKeypad ? "yes" : "no"}`,
    );
    console.log(
      `first non-system   ${personAt === null ? "none identified" : personAt + "s (a candidate, not a confirmed person)"}`,
    );
    console.log("");
    // No verdict on whether the agent *navigated*. Four heuristics were tried
    // here and all four were too loose: matching "press" anywhere, then keypad
    // words, then any reply after a prompt — each one called a call navigated
    // that was not. On one real call the agent said "Okay" twenty-six times to
    // a looping announcement and every rule so far scored it a success.
    //
    // Whether a tree was worked is a judgement, and the honest tool reports
    // what it can see and hands the judgement to a person.
    if (!menuHeard) {
      console.log("NO MENU — nothing in this call had a phone tree to traverse.");
    } else {
      console.log("A real phone tree was reached and transcribed.");
      console.log("Whether the agent worked it is not something this tool decides:");
      console.log("read the transcript in the masked file and judge it yourself.");
    }
  }
}

async function persist(call: Call, label: string): Promise<void> {
  await mkdir(OUTPUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");

  // The raw file holds an unmasked transcript of a real conversation. It is
  // gitignored and must stay that way.
  const raw = path.join(OUTPUT_DIR, `${label}-${stamp}.raw.json`);
  await writeFile(raw, JSON.stringify(call, null, 2), "utf8");

  // The masked file is the one safe to paste into a PR or an issue.
  const masked = path.join(OUTPUT_DIR, `${label}-${stamp}.masked.json`);
  await writeFile(masked, JSON.stringify(redact(call), null, 2), "utf8");

  console.log(`raw (private)      ${raw}`);
  console.log(`masked (shareable) ${masked}`);
}

async function confirmLive(to: string): Promise<boolean> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    console.log(`\nThis places ONE real phone call to ${maskPhone(to)} and will be billed.`);
    const answer = await rl.question('Type LIVE to place it, anything else to abort: ');
    return answer.trim() === "LIVE";
  } finally {
    rl.close();
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  if (args.check) {
    const apiKey = process.env["CALLE_API_KEY"];
    if (!apiKey) {
      console.error("CALLE_API_KEY is not set. Copy .env.example to .env and fill it in.");
      return 2;
    }
    return checkCredentials(apiKey);
  }

  // The default goal asks to reach a person, which is right when the number is
  // yours. Against a public line it is not: it occupies someone's time to
  // answer a question we do not actually have. `--menu-only` walks the tree,
  // reports what it heard, and hangs up without queueing for an agent.
  // CALL-E plans before it dials and refuses a task it cannot picture. It
  // rejected "press a keypad option and report what you hear" with a 422 and
  // the question "which menu option, department, or purpose should the
  // assistant try to reach?" — a good refusal that cost nothing. A menu-only
  // probe still has to name where it is going.
  const MENU_ONLY_GOAL =
    "Reach the package tracking option by keypad and report the choices offered there.";

  const goal = args.goal ?? (args.menuOnly ? MENU_ONLY_GOAL : "Reach a representative and confirm which department you have been connected to.");

  const compiled = buildTask(goal, args.menuOnly);
  console.log(`compiled task (${compiled.used}/${compiled.budget} chars)`);
  console.log(`  "${compiled.task}"`);
  if (compiled.dropped.length > 0) console.log(`  dropped: ${compiled.dropped.join(", ")}`);

  if (args.fixture) {
    const call = JSON.parse(await readFile(args.fixture, "utf8")) as Call;
    console.log(`\nreplaying fixture ${args.fixture} — no network, no call`);
    report(call);
    return 0;
  }

  if (!args.live) {
    console.log("\nPlan only. Nothing was dialed. Add --live to place one real call.");
    return 0;
  }

  const to = args.to ?? process.env["HOLDLINE_PROBE_NUMBER"] ?? "";
  const check = checkPhone(to);
  if (!check.ok) {
    console.error(`\nRefusing to dial: ${check.reason}. Set --to or HOLDLINE_PROBE_NUMBER.`);
    return 2;
  }

  // Refuse an unreachable region here rather than learning it from a 422.
  // The provider is the authority; this is a courtesy, so it names what would
  // work instead of only saying no.
  const region = regionForNumber(check.e164);
  if (!region) {
    console.error(`\n${maskPhone(check.e164)} is not in a region CALL-E can call.`);
    console.error("Argentina (+54), for one, is not on the supported list in any language.");
    console.error("\nSpanish-language calls are supported here:");
    for (const option of regionsSpeaking("Spanish")) {
      console.error(`  ${option.country} (${option.dialing}) — ${option.line} line`);
    }
    console.error("\nFull list: https://github.com/CALLE-AI/call-e-integrations#supported-regions-and-languages");
    return 2;
  }

  console.log(`\nregion             ${region.country} (${region.code}) — ${region.line} line`);
  console.log(`languages          ${region.languages.join(", ")}`);
  if (!args.locale && !region.languages.includes("English")) {
    console.error(
      `\n${region.country} does not support English. Pass --locale, for example --locale ${region.languages[0]?.slice(0, 2).toLowerCase()}-${region.code}.`,
    );
    return 2;
  }

  const apiKey = process.env["CALLE_API_KEY"];
  if (!apiKey) {
    console.error("\nCALLE_API_KEY is not set. Copy .env.example to .env and fill it in.");
    return 2;
  }

  const label = process.env["HOLDLINE_PROBE_LABEL"] ?? "day1-traversal";
  const client = new CalleClient({ apiKey });
  // The probe is a test tool, so what it asks changes between runs. Deriving
  // the key from the label alone made every run share one key: the first
  // attempt registered that key with one request, and the next one — different
  // number, different task — came back 409 `idempotency_conflict`.
  //
  // The authorizing event for a probe is "this label, this number, this task",
  // so the digest of the number and the task becomes the sequence. Re-running
  // the identical probe is still idempotent; changing either is a new intent.
  // The number is hashed, never carried in the key.
  const shape = createHash("sha256")
    .update(`${check.e164}|${compiled.task}`, "utf8")
    .digest("hex")
    .slice(0, 12);

  const idempotencyKey = deriveIdempotencyKey({
    workflow: "probe",
    subjectId: label,
    intent: "traversal-check",
    sequence: shape,
  });

  console.log(`idempotency key    ${idempotencyKey}`);

  if (!(await confirmLive(check.e164))) {
    console.log("Aborted. Nothing was dialed.");
    return 1;
  }

  try {
    const call = await client.calls.createAndWait(
      {
        task: compiled.task,
        recipient: {
          phone: check.e164,
          ...(args.locale ? { locale: args.locale } : {}),
          ...(args.region ? { region: args.region } : { region: region.code }),
        },
        resultSchema: RESULT_SCHEMA as unknown as Record<string, unknown>,
        metadata: { holdline_probe: label },
      },
      { idempotencyKey, timeoutMs: 10 * 60 * 1000 },
    );
    report(call);
    await persist(call, label);
    return 0;
  } catch (error) {
    const classification = classifyFailure(error);
    console.error("\nProbe failed.");
    console.error(JSON.stringify(redactError(error), null, 2));
    console.error(`\nclassification  ${classification.class} (${classification.code})`);
    console.error(`reason          ${classification.reason}`);
    if (classification.class === "reconcile") {
      console.error(
        `\nDo NOT re-run blindly. Reuse idempotency key ${idempotencyKey} to find out what happened.`,
      );
    }
    return 3;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(JSON.stringify(redactError(error), null, 2));
    process.exit(3);
  });
