/**
 * `npm run replay` — put a call that already happened back through the gate.
 *
 * The gate normally runs inside a dispatch, moments after the call ends. This
 * runs it over a saved call instead, which is useful three times over: to
 * re-judge a call with better probes after the first set missed, to show the
 * gate working on real speech without dialing anyone, and to check a change to
 * the gate against a transcript whose right answer is already known.
 *
 * With no arguments it replays the synthetic fixture in `fixtures/`, which is
 * labelled as synthetic and carries a structured result worth arguing with.
 *
 *   npm run replay
 *   npm run replay -- --call probe-output/run.masked.json \
 *                     --field in_stock="in stock,have any,availability"
 *
 * `--no-quotes` prints the verdicts without the sentence that established each
 * one. Use it for anything that leaves this directory: a real call's words are
 * not kept in this repository, and that promise is only worth making if the
 * tooling makes it easy to keep.
 *
 * It reads a file and prints. No network, no key, no call.
 */

import { readFileSync } from "node:fs";

import { runEvidenceGate, gatedResult } from "../evidence/gate.js";
import type { CallTranscriptTurn, CompletionConfidence, FieldProbe } from "../evidence/types.js";

const DEFAULT_CALL = new URL("../../fixtures/traversal-with-menu.json", import.meta.url);

/**
 * The probes the default fixture is judged with. Written after the words the
 * agent says, not after the field names — see `references/probes.md`.
 *
 * They are deliberately uneven, because that is what makes the demo worth
 * running: the agent does ask which department it reached, so that field is
 * established. Nothing in the call asks whether a person was reached, and yet
 * a value for it comes back — which is the case the gate exists to catch.
 */
const DEFAULT_PROBES: FieldProbe[] = [
  { field: "department_confirmed", required: true, asks: ["account services department", "am i speaking with"] },
  { field: "reached_human", required: true, asks: ["are you a person", "speak to a human"] },
];

interface SavedCall {
  structuredResult?: Record<string, unknown> | null;
  completionConfidence?: CompletionConfidence | null;
  transcriptTurns?: CallTranscriptTurn[];
  recipients?: {
    structuredResult?: Record<string, unknown> | null;
    attempts?: { transcriptTurns?: CallTranscriptTurn[] }[];
  }[];
  /** `npm run call` used to write a record with the call nested here. */
  call?: SavedCall;
  /** It writes one call per target now, under this key. */
  calls?: (SavedCall | null)[];
  /** Per-target outcomes, used only for the masked label on each block. */
  targets?: { maskedPhone?: string; label?: string }[];
}

/**
 * Every call in whatever was saved.
 *
 * Four shapes are in circulation: a flattened fixture, a raw masked API
 * response, the single-call record `npm run call` used to write, and the batch
 * record it writes now — one call per target, under `calls`. This read two of
 * them, then three. Replaying a batch this repository had just placed failed
 * with "that file has no transcript turns", which is a poor way to learn that
 * two tools in the same repo do not speak to each other.
 */
function callsOf(saved: SavedCall): SavedCall[] {
  if (saved.calls && saved.calls.length > 0) return saved.calls.filter((call): call is SavedCall => call !== null);
  return [saved.call ?? saved];
}

function turnsOf(call: SavedCall): CallTranscriptTurn[] {
  if (call.transcriptTurns?.length) return call.transcriptTurns;
  return (call.recipients ?? []).flatMap((r) => (r.attempts ?? []).flatMap((a) => a.transcriptTurns ?? []));
}

/** The root result when there is one, else the first recipient's. */
function resultOf(call: SavedCall): Record<string, unknown> | null {
  if (call.structuredResult) return call.structuredResult;
  return (call.recipients ?? []).find((r) => r.structuredResult)?.structuredResult ?? null;
}

function parseArgs(argv: string[]): { call: string | URL; probes: FieldProbe[]; quotes: boolean } {
  let call: string | URL = DEFAULT_CALL;
  let quotes = true;
  const probes: FieldProbe[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--no-quotes") {
      quotes = false;
    } else if (arg === "--call") {
      const next = argv[i + 1];
      if (!next) throw new Error("--call needs a path.");
      call = next;
      i += 1;
    } else if (arg === "--field") {
      const next = argv[i + 1];
      if (!next) throw new Error('--field needs name="ask,ask".');
      const split = next.indexOf("=");
      if (split < 1) throw new Error(`--field ${next} is not name=asks.`);
      const asks = next
        .slice(split + 1)
        .split(",")
        .map((ask) => ask.trim())
        .filter(Boolean);
      if (asks.length === 0) throw new Error(`--field ${next.slice(0, split)} has no asks.`);
      probes.push({ field: next.slice(0, split), required: true, asks });
      i += 1;
    }
  }

  return { call, probes: probes.length > 0 ? probes : DEFAULT_PROBES, quotes };
}

const pad = (text: string, width: number) => text.padEnd(width);

function main(): void {
  const { call: source, probes, quotes } = parseArgs(process.argv.slice(2));
  const saved = JSON.parse(readFileSync(source, "utf8")) as SavedCall;
  const calls = callsOf(saved);
  if (calls.every((call) => turnsOf(call).length === 0)) {
    throw new Error("That file has no transcript turns.");
  }

  for (const [index, call] of calls.entries()) {
    const label = saved.targets?.[index];
    if (calls.length > 1) {
      const name = label?.label ?? `target ${index + 1}`;
      const masked = label?.maskedPhone ?? "";
      process.stdout.write(`\n  ── ${name}  ${masked}`.trimEnd() + "\n");
    }
    judgeAndPrint(call, probes, quotes);
  }
}

function judgeAndPrint(call: SavedCall, probes: FieldProbe[], quotes: boolean): void {
  const turns = turnsOf(call);

  const reported = resultOf(call);

  const report = runEvidenceGate({
    structuredResult: reported,
    transcriptTurns: turns,
    probes,
    completionConfidence: call.completionConfidence ?? null,
  });
  const gated = gatedResult(report, reported);

  const out = process.stdout;
  const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;
  out.write(`\n  ${plural(turns.length, "turn")}  ·  ${plural(probes.length, "field")}  ·  no call placed\n\n`);

  out.write("  What the call reported\n");
  for (const [field, value] of Object.entries(reported ?? {})) {
    const shown = typeof value === "string" && value.length > 58 ? `${value.slice(0, 55)}...` : JSON.stringify(value);
    out.write(`    ${pad(field, 24)} ${shown}\n`);
  }
  const score = call.completionConfidence?.score;
  if (score !== undefined) out.write(`    ${pad("(confidence)", 24)} ${score}\n`);

  out.write("\n  What the transcript supports\n");
  for (const field of report.fields) {
    out.write(`    ${pad(field.field, 24)} ${field.verdict}\n`);
    if (field.supportingTurn && quotes) out.write(`    ${pad("", 24)} "${field.supportingTurn}"\n`);
    else if (field.supportingTurn)
      out.write(`    ${pad("", 24)} (established by a turn this repository does not keep)\n`);
    else if (field.note) out.write(`    ${pad("", 24)} ${field.note}\n`);
  }

  out.write(`\n  Verdict  ${report.verdict}\n`);
  for (const reason of report.reasons) out.write(`           ${reason}\n`);

  out.write("\n  What a caller is given\n");
  for (const [field, value] of Object.entries(gated)) {
    const shown = typeof value === "string" && value.length > 58 ? `${value.slice(0, 55)}...` : JSON.stringify(value);
    out.write(`    ${pad(field, 24)} ${shown}${value === null ? "   (withheld)" : ""}\n`);
  }

  // A field with no probe was never judged, so the gate does not pass it on.
  // Saying nothing about it would be the same silence this project exists to
  // break, so it is named.
  const unjudged = Object.keys(reported ?? {}).filter((field) => !(field in gated));
  if (unjudged.length > 0) {
    out.write(`\n  Dropped, having no probe and so never judged: ${unjudged.join(", ")}\n`);
  }
  out.write("\n");
}

main();
