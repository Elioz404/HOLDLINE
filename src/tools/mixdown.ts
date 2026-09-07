/**
 * `npm run mixdown` — finish the video: encode, lay the voice under it, and
 * write the subtitle file.
 *
 * `video.ts` recorded where every caption actually appeared. This places each
 * line of narration at that same offset, so the voice lands with the words on
 * screen without anyone nudging a waveform. The subtitle file comes from the
 * same numbers, which is why it cannot disagree with either.
 *
 * Three outputs in `docs/video/`:
 *   holdline.mp4   1920×1080 H.264 with narration — the deliverable
 *   holdline.srt   subtitles, for YouTube's caption track
 *   holdline-silent.mp4  the picture alone, kept for re-mixing
 *
 * The burned-in captions stay. The srt is for viewers who turn captions on and
 * for YouTube's transcript; they carry the same text.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const DIR = "docs/video";
const RAW = `${DIR}/holdline-raw.webm`;
const SILENT = `${DIR}/holdline-silent.mp4`;
const FINAL = `${DIR}/holdline.mp4`;
const SRT = `${DIR}/holdline.srt`;
const VOICE_TRACK = `${DIR}/narration.wav`;

interface Cue {
  readonly index: number;
  readonly startMs: number;
  readonly endMs: number;
  readonly caption: string;
  readonly speech: string;
  readonly audio: string;
}

const ffmpeg = (args: string[]): void => {
  execFileSync("ffmpeg", ["-y", "-v", "error", ...args], { stdio: "inherit" });
};

/** `00:01:23,450` — SubRip wants a comma before the milliseconds. */
function stamp(ms: number): string {
  const t = Math.max(0, Math.round(ms));
  const h = Math.floor(t / 3_600_000);
  const m = Math.floor((t % 3_600_000) / 60_000);
  const s = Math.floor((t % 60_000) / 1000);
  const milli = t % 1000;
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(milli, 3)}`;
}

/** Subtitles carry the words, not the emphasis markup the page uses. */
const plain = (caption: string): string =>
  caption.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();

function main(): void {
  if (!existsSync(RAW)) throw new Error(`${RAW} is missing. Run npm run video first.`);
  const { cues } = JSON.parse(readFileSync(`${DIR}/timing.json`, "utf8")) as { cues: Cue[] };
  if (cues.length === 0) throw new Error("timing.json has no cues.");

  process.stdout.write("  encoding picture…\n");
  ffmpeg([
    "-i", RAW,
    "-vf", "scale=1920:1080:flags=lanczos",
    "-c:v", "libx264", "-preset", "slow", "-crf", "19",
    "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-r", "25",
    SILENT,
  ]);

  // One input per line, each delayed to the offset the caption appeared at,
  // then summed. `amix` alone would duck every clip by the number of inputs,
  // so normalize is off and the sum is capped instead.
  process.stdout.write(`  building voice track from ${cues.length} lines…\n`);
  const inputs = cues.flatMap((cue) => ["-i", cue.audio]);
  const delays = cues
    .map((cue, i) => `[${i}:a]adelay=${Math.round(cue.startMs)}:all=1[d${i}]`)
    .join(";");
  const merge = `${cues.map((_, i) => `[d${i}]`).join("")}amix=inputs=${cues.length}:normalize=0:dropout_transition=0[out]`;
  ffmpeg([
    ...inputs,
    "-filter_complex", `${delays};${merge}`,
    "-map", "[out]", "-ar", "48000", "-ac", "2",
    VOICE_TRACK,
  ]);

  process.stdout.write("  muxing…\n");
  ffmpeg([
    "-i", SILENT, "-i", VOICE_TRACK,
    "-map", "0:v", "-map", "1:a",
    "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
    FINAL,
  ]);

  const srt = cues
    .map((cue, i) => `${i + 1}\n${stamp(cue.startMs)} --> ${stamp(cue.endMs)}\n${plain(cue.caption)}\n`)
    .join("\n");
  writeFileSync(SRT, `${srt}\n`, "utf8");

  const duration = execFileSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", FINAL],
    { encoding: "utf8" },
  ).trim();
  const seconds = Number.parseFloat(duration);
  const runtime = `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(1).padStart(4, "0")}`;

  process.stdout.write(`\n  ${FINAL}   ${runtime}${seconds < 180 ? "" : "   OVER THE 3:00 LIMIT"}\n`);
  process.stdout.write(`  ${SRT}   ${cues.length} cues\n\n`);
}

main();
