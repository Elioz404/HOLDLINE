/// <reference lib="dom" />
/**
 * `npm run demo` — drive the console through the recording script, hands-free.
 *
 * It opens a real Chrome window, starts the console behind it, and walks the
 * whole flow at the pace the narration needs. You press record and talk; it
 * does the clicking. Every take is identical, so a fluffed line costs one more
 * take rather than a fresh attempt at hitting the right button on time.
 *
 * The beats match `submission/video.md`. Each one prints to the terminal as it
 * starts, with the line you should be saying, so a second screen can act as an
 * autocue.
 *
 * Simulation only. It places no call and needs no key.
 *
 * The DOM lib is referenced for this file alone: the callbacks handed to
 * `page.evaluate` run inside the browser.
 */

import { existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import puppeteer, { type Browser, type Page } from "puppeteer-core";

import { createConsole } from "../console/server.js";

const CHROME_CANDIDATES = [
  process.env["CHROME_PATH"],
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter((path): path is string => typeof path === "string");

function findChrome(): string {
  const found = CHROME_CANDIDATES.find((path) => existsSync(path));
  if (!found) throw new Error(`No Chrome found. Set CHROME_PATH. Looked in:\n  ${CHROME_CANDIDATES.join("\n  ")}`);
  return found;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** How long each beat holds before the next. Tuned to the shot list. */
const BEATS = {
  settle: 3_000,
  atRest: 15_000,
  afterPlan: 24_000,
  beforeRun: 3_000,
  afterVerdicts: 18_000,
} as const;

function beat(label: string, say: string): void {
  process.stdout.write(`\n── ${label} ${"─".repeat(Math.max(0, 46 - label.length))}\n`);
  for (const line of say.split("\n")) process.stdout.write(`   ${line}\n`);
}

async function waitFor(page: Page, what: string, check: () => boolean, timeoutMs = 30_000): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (await page.evaluate(check)) return;
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for: ${what}`);
    await sleep(150);
  }
}

async function main(): Promise<void> {
  const server = createConsole({ simulate: true });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  let browser: Browser | undefined;
  try {
    browser = await puppeteer.launch({
      executablePath: findChrome(),
      headless: false,
      defaultViewport: null,
      args: ["--window-size=1440,960", "--window-position=40,40", "--force-color-profile=srgb"],
    });
    const [page] = await browser.pages();
    if (!page) throw new Error("Chrome opened with no page.");

    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
    await page.goto(`http://127.0.0.1:${port}`, { waitUntil: "networkidle0" });
    await waitFor(page, "the console to settle", () =>
      document.getElementById("mode")!.textContent !== "checking…",
    );

    process.stdout.write("\nConsole is up. Start your screen recorder now.\n");
    process.stdout.write("The run begins in 10 seconds and takes about 90.\n");
    await sleep(10_000);

    beat(
      "0:00  the problem",
      '"A patient is medically ready to leave hospital and can\'t, because nobody\n' +
        ' has confirmed a bed. So a coordinator rings eight care homes, one at a\n' +
        ' time, through eight phone menus."',
    );
    await sleep(BEATS.atRest);

    beat(
      "0:18  plan",
      '"Two questions, four homes, one dispatch. HOLDLINE compiles it into the 255\n' +
        ' characters the API allows and shows you exactly what will be said."\n' +
        'Then: the character meter, the refused row, the idempotency key.',
    );
    await page.click("#plan");
    await waitFor(page, "the plan", () =>
      document.getElementById("planout")!.textContent!.includes("Compiled task"),
    );
    await sleep(BEATS.afterPlan);

    beat(
      "0:45  the wait — say nothing for five seconds",
      '"Three homes, one dispatch, all three sitting in the queue at once. That\n' +
        ' clock is the call\'s own clock. Nobody is listening to this."\n' +
        'Let it reach "a person answered" before speaking again.',
    );
    await page.evaluate(() => {
      const box = document.getElementById("confirm") as HTMLInputElement;
      box.checked = true;
      box.dispatchEvent(new Event("change"));
    });
    await sleep(BEATS.beforeRun);
    await page.evaluate(() => document.getElementById("run")!.click());

    await waitFor(page, "the board to start holding", () =>
      Array.from(document.querySelectorAll(".liverow")).some(
        (row) => row.querySelector("[data-phase]")?.textContent === "holding",
      ),
    );

    await waitFor(page, "the verdicts", () => document.querySelectorAll("#cards .card").length >= 3, 60_000);
    await page.evaluate(() => document.getElementById("summary")?.scrollIntoView({ block: "start" }));

    beat(
      "1:15  the moment",
      '"Three reached, the fourth refused before dialing. Different answers."\n' +
        'Point at the verified card, then the withheld one.\n' +
        '"The nursing level came back populated and confident. But no question in\n' +
        ' that call could have produced it. So it does not come back."\n' +
        '"That\'s a patient who doesn\'t get moved tomorrow on an answer nobody gave."',
    );
    await sleep(BEATS.afterVerdicts);

    process.stdout.write("\nScreen run finished. Stop recording, or leave the window open for a second take.\n");
    process.stdout.write("Then cut to the terminal for `npm run eval` and the MCP tool list.\n\n");
    process.stdout.write("Press Ctrl+C to close the browser.\n");

    // Hold the window open so a second take needs no restart.
    await new Promise<void>(() => {});
  } finally {
    await browser?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  process.exit(1);
});
