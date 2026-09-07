/**
 * `npm run video` — record the demo, end to end, with no camera and no hands.
 *
 * It starts the console in-process, drives a real Chrome window through every
 * beat, and records with Puppeteer's screencast.
 *
 * The picture is cut to the voice. `npm run narrate` renders the script first
 * and measures every line; each caption here is then held for exactly as long
 * as its line of audio runs, and the wall-clock offset at which it appeared is
 * written to `docs/video/timing.json`. `npm run mixdown` lays the audio back
 * over the recording at those offsets and writes the subtitle file from the
 * same numbers, so picture, voice and subtitles cannot drift apart and none of
 * it is hand-edited.
 *
 * The terminal segments are not mock-ups. `docs/video/out-replay.txt` and
 * `out-eval.txt` are captured from real runs of `npm run replay` and
 * `npm run eval` before recording, and printed verbatim.
 *
 * The console runs in simulation, says so in its header throughout, and a
 * caption says so out loud. The only real calls shown are the ones in
 * `fixtures/`, judged on camera.
 *
 * The DOM lib is referenced for this file alone: the callbacks handed to
 * `page.evaluate` run inside the browser.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import puppeteer, { type Browser } from "puppeteer-core";

import { createConsole } from "../console/server.js";
import { FRAME, clearCaption, findChrome, installCaption, setCaption, sleep, terminalPage, until } from "./browser.js";
import type { NarratedLine } from "./narration.js";

const OUT_DIR = "docs/video";
const RAW = `${OUT_DIR}/holdline-raw.webm`;

/** Breath between one line ending and the next caption replacing it. */
const PAD_MS = 360;

interface CueTiming {
  readonly index: number;
  readonly startMs: number;
  readonly endMs: number;
  readonly caption: string;
  readonly speech: string;
  readonly audio: string;
}

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });

  const manifestPath = `${OUT_DIR}/narration.json`;
  if (!existsSync(manifestPath)) throw new Error(`${manifestPath} is missing. Run npm run narrate first.`);
  const narration = JSON.parse(readFileSync(manifestPath, "utf8")) as { lines: NarratedLine[] };
  const lines = narration.lines;

  const replayOut = readFileSync(`${OUT_DIR}/out-replay.txt`, "utf8").replace(/\s+$/, "");
  const evalOut = readFileSync(`${OUT_DIR}/out-eval.txt`, "utf8").replace(/\s+$/, "");

  const server = createConsole({ simulate: true });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  const cues: CueTiming[] = [];
  let originMs = 0;

  let browser: Browser | undefined;
  try {
    browser = await puppeteer.launch({
      executablePath: findChrome(),
      headless: false,
      defaultViewport: null,
      args: ["--window-size=1296,800", "--window-position=30,30", "--force-color-profile=srgb", "--hide-scrollbars"],
    });
    const [page] = await browser.pages();
    if (!page) throw new Error("Chrome opened with no page.");

    await page.setViewport({ ...FRAME });
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
    await page.goto(`http://127.0.0.1:${port}`, { waitUntil: "networkidle0" });
    await until(page, "the console to settle", () => document.getElementById("mode")!.textContent !== "checking…");
    await installCaption(page);

    const recorder = await page.screencast({ path: RAW as `${string}.webm`, fps: 25 });
    originMs = Date.now();
    process.stdout.write("Recording…\n");
    await sleep(800);

    /** Show line `index`, hold it for exactly its audio, and note where it fell. */
    const say = async (index: number, clear = false): Promise<void> => {
      const line = lines[index];
      if (!line) throw new Error(`No narrated line ${index}. Re-run npm run narrate.`);
      const startMs = Date.now() - originMs;
      await setCaption(page, line.caption);
      await sleep(Math.round(line.seconds * 1000) + PAD_MS);
      cues.push({
        index,
        startMs,
        endMs: Date.now() - originMs,
        caption: line.caption,
        speech: line.speech,
        audio: line.file,
      });
      if (clear) {
        await clearCaption(page);
        await sleep(280);
      }
    };

    // ── the problem ───────────────────────────────────────────────────────
    await say(0);
    await say(1);
    await say(2, true);

    // ── plan ──────────────────────────────────────────────────────────────
    await page.evaluate(() => document.getElementById("plan")!.click());
    await until(page, "the plan", () => document.getElementById("planout")!.textContent!.includes("Compiled task"));
    await sleep(600);
    await say(3);
    // The refused row sits below the fold here. Narrating a refusal over a
    // screen that does not show it is a caption describing something the
    // viewer cannot see.
    await page.evaluate(() => {
      const label = Array.from(document.querySelectorAll("#planout label")).find((el) =>
        el.textContent?.includes("Refused before dialing"),
      );
      label?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
    await sleep(700);
    await say(4);
    await say(5, true);

    // ── on the line ───────────────────────────────────────────────────────
    await page.evaluate(() => {
      const box = document.getElementById("confirm") as HTMLInputElement;
      box.checked = true;
      box.dispatchEvent(new Event("change"));
    });
    await sleep(500);
    await page.evaluate(() => document.getElementById("run")!.click());
    await until(page, "the board to appear", () => document.querySelectorAll(".liverow").length > 0);
    await page.evaluate(() => document.getElementById("board")?.scrollIntoView({ block: "center" }));
    await until(page, "every row past a minute on the clock", () => {
      const rows = Array.from(document.querySelectorAll(".liverow"));
      if (rows.length === 0) return false;
      return rows.every((row) => {
        const clock = row.querySelector("[data-clock]")?.textContent ?? "0:00";
        const [m = "0", s = "0"] = clock.split(":");
        return Number(m) * 60 + Number(s) >= 60;
      });
    });
    await say(6);
    await say(7, true);

    // ── the verdicts ──────────────────────────────────────────────────────
    await until(page, "the verdicts", () => document.querySelectorAll("#cards .card").length >= 3, 90_000);
    await page.evaluate(() => document.getElementById("summary")?.scrollIntoView({ block: "start" }));
    await sleep(700);
    await say(8);
    await say(9);
    await page.evaluate(() => document.querySelectorAll("#cards .card")[1]?.scrollIntoView({ block: "center", behavior: "smooth" }));
    await sleep(700);
    await say(10);
    await say(11, true);

    // ── a real call ───────────────────────────────────────────────────────
    await page.setContent(terminalPage("npm run replay — a real CALL-E call, judged", replayOut), { waitUntil: "load" });
    await installCaption(page);
    await sleep(900);
    await say(12);
    await say(13);
    await say(14, true);

    // ── the call that caught us ───────────────────────────────────────────
    await page.setContent(
      terminalPage(
        "the call that caught us",
        [
          "  A live call to an automated line came back like this:",
          "",
          "    verdict   verified",
          "    answers   { field: <a whole sentence saying no explanation was",
          "                 given, and the call ended before answering> }",
          "",
          "  A value that says nothing was established \u2014 waved through as verified.",
          "  The usable-value check only knew the tokens \u201cunknown\u201d, \u201cn/a\u201d, \u201cnone\u201d.",
          "",
          "  The unit suite missed it. 400 evaluated cases missed it too, because",
          "  every value in that corpus was one word long. A phone call found it.",
        ].join("\n"),
      ),
      { waitUntil: "load" },
    );
    await installCaption(page);
    await sleep(900);
    await say(15);
    await say(16);
    await say(17, true);

    // ── the numbers ───────────────────────────────────────────────────────
    await page.setContent(terminalPage("npm run eval — 400 labelled cases, no calls placed", evalOut), { waitUntil: "load" });
    await installCaption(page);
    await sleep(900);
    await say(18);
    await say(19);
    await say(20, true);

    await sleep(600);
    await recorder.stop();

    const totalMs = Date.now() - originMs;
    writeFileSync(`${OUT_DIR}/timing.json`, `${JSON.stringify({ totalMs, cues }, null, 2)}\n`, "utf8");
    process.stdout.write(`Wrote ${RAW} and ${OUT_DIR}/timing.json — ${(totalMs / 1000).toFixed(1)}s\n`);
  } finally {
    await browser?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  process.exit(1);
});
