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
  recipients?: { attempts?: { transcriptTurns?: CallTranscriptTurn[] }[] }[];
}

/** Accepts either a flattened fixture or a raw masked API response. */
function turnsOf(call: SavedCall): CallTranscriptTurn[] {
  if (call.transcriptTurns?.length) return call.transcriptTurns;
  return (call.recipients ?? []).flatMap((r) => (r.attempts ?? []).flatMap((a) => a.transcriptTurns ?? []));
}

function parseArgs(argv: string[]): { call: string | URL; probes: FieldProbe[] } {
  let call: string | URL = DEFAULT_CALL;
  const probes: FieldProbe[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--call") {
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

  return { call, probes: probes.length > 0 ? probes : DEFAULT_PROBES };
}

const pad = (text: string, width: number) => text.padEnd(width);

function main(): void {
  const { call: source, probes } = parseArgs(process.argv.slice(2));
  const call = JSON.parse(readFileSync(source, "utf8")) as SavedCall;
  const turns = turnsOf(call);
  if (turns.length === 0) throw new Error("That file has no transcript turns.");

  const report = runEvidenceGate({
    structuredResult: call.structuredResult ?? null,
    transcriptTurns: turns,
    probes,
    completionConfidence: call.completionConfidence ?? null,
  });
  const gated = gatedResult(report, call.structuredResult ?? null);

  const out = process.stdout;
  out.write(`\n  ${turns.length} turns  ·  ${probes.length} fields  ·  no call placed\n\n`);

  out.write("  What the call reported\n");
  for (const [field, value] of Object.entries(call.structuredResult ?? {})) {
    const shown = typeof value === "string" && value.length > 58 ? `${value.slice(0, 55)}...` : JSON.stringify(value);
    out.write(`    ${pad(field, 24)} ${shown}\n`);
  }
  const score = call.completionConfidence?.score;
  if (score !== undefined) out.write(`    ${pad("(confidence)", 24)} ${score}\n`);

  out.write("\n  What the transcript supports\n");
  for (const field of report.fields) {
    out.write(`    ${pad(field.field, 24)} ${field.verdict}\n`);
    if (field.supportingTurn) out.write(`    ${pad("", 24)} "${field.supportingTurn}"\n`);
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
  const unjudged = Object.keys(call.structuredResult ?? {}).filter((field) => !(field in gated));
  if (unjudged.length > 0) {
    out.write(`\n  Dropped, having no probe and so never judged: ${unjudged.join(", ")}\n`);
  }
  out.write("\n");
}

main();
