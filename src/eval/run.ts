/**
 * `npm run eval` — print the Evidence Gate evaluation.
 *
 * Offline and deterministic. Takes no credentials and places no calls.
 *
 *   npm run eval
 *   npm run eval -- --size 1000 --seed 7
 */

import { formatComparison, formatReport, runEvaluation } from "./harness.js";

function arg(name: string, fallback: number): number {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = Number(process.argv[index + 1]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const size = arg("size", 400);
const seed = arg("seed", 20260906);

console.log(formatReport(runEvaluation(size, seed)));
console.log();
console.log(formatComparison(size, seed));
