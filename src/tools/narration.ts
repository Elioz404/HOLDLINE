/**
 * `npm run narrate` — speak the script, and measure it.
 *
 * Reads `script.ts`, renders one audio file per line with Microsoft Edge's
 * neural voices via `edge-tts`, and measures each with ffprobe. The result is
 * `docs/video/narration.json`, which `video.ts` uses to hold every caption for
 * exactly as long as its line of audio runs.
 *
 * Cutting the picture to the voice, rather than recording the picture and then
 * hoping a voice fits it, is the only way these stay in sync without hand
 * editing — and hand editing is what makes a demo unreproducible.
 *
 * `edge-tts` is fetched on demand by `uvx`, so nothing is installed
 * permanently. It needs network; the audio it produces is then local and the
 * rest of the pipeline is offline.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { SCRIPT } from "./script.js";

const AUDIO_DIR = "docs/video/audio";
const MANIFEST = "docs/video/narration.json";

/**
 * "Warm, Confident, Authentic, Honest" in Microsoft's own description, which
 * is the register this script is written in. `-8%` because the lines carry
 * figures and quoted verdicts, and the default pace runs over them.
 */
const VOICE = "en-US-AndrewNeural";
const RATE = "-8%";

export interface NarratedLine {
  readonly index: number;
  readonly file: string;
  readonly seconds: number;
  readonly caption: string;
  readonly speech: string;
}

function durationOf(file: string): number {
  const out = execFileSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file],
    { encoding: "utf8" },
  );
  const seconds = Number.parseFloat(out.trim());
  if (!Number.isFinite(seconds)) throw new Error(`ffprobe gave no duration for ${file}`);
  return seconds;
}

function main(): void {
  mkdirSync(AUDIO_DIR, { recursive: true });

  const lines: NarratedLine[] = [];
  let total = 0;

  for (const [index, line] of SCRIPT.entries()) {
    const file = join(AUDIO_DIR, `line-${String(index).padStart(2, "0")}.mp3`);
    execFileSync(
      "uvx",
      // `--rate=-8%` must be one token: passed separately, argparse reads the
      // leading minus as the start of another flag and refuses.
      ["edge-tts", "--voice", VOICE, `--rate=${RATE}`, "--text", line.speech, "--write-media", file],
      { stdio: ["ignore", "ignore", "inherit"] },
    );
    const seconds = durationOf(file);
    total += seconds;
    lines.push({ index, file, seconds, caption: line.caption, speech: line.speech });
    process.stdout.write(`  ${String(index).padStart(2)}  ${seconds.toFixed(2)}s  ${line.speech.slice(0, 62)}\n`);
  }

  writeFileSync(MANIFEST, `${JSON.stringify({ voice: VOICE, rate: RATE, lines }, null, 2)}\n`, "utf8");
  process.stdout.write(`\n  ${lines.length} lines, ${total.toFixed(1)}s of speech\n`);
  process.stdout.write(`  wrote ${MANIFEST}\n\n`);
}

main();
