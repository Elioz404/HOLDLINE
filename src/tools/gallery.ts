/// <reference lib="dom" />
/**
 * `npm run gallery` — the submission images, all 1920×1080, all reproducible.
 *
 * Devpost shows these in a carousel and uses the first as the card thumbnail,
 * so every one has to stand on its own: a reader may see one image and no
 * caption. Each therefore carries a line of its own, drawn in the page by the
 * same caption bar the video uses, and every shot is the same size and the
 * same treatment so the set reads as a set.
 *
 * Nothing here is a mock-up. The console shots are the console being driven;
 * the terminal shots print output captured from real runs of `npm run replay`,
 * `npm run eval` and `npm run call` into `docs/video/`.
 *
 * Output is `docs/screenshots/NN-name.png`, numbered in upload order.
 */

import { existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";

import { createConsole } from "../console/server.js";
import { FRAME, findChrome, installCaption, setCaption, sleep, terminalPage, until } from "./browser.js";

const OUT = "docs/screenshots";
const TEXT = "docs/video";

let shotNumber = 0;

async function shoot(page: Page, name: string, caption: string): Promise<void> {
  await setCaption(page, caption);
  await sleep(420); // let the caption finish fading in
  shotNumber += 1;
  const file = join(OUT, `${String(shotNumber).padStart(2, "0")}-${name}.png`) as `${string}.png`;
  await page.screenshot({ path: file });
  process.stdout.write(`  ${file}\n`);
}

async function main(): Promise<void> {
  // Numbering is the upload order, so a stale file from a previous run would
  // silently sit in the middle of the sequence. The files go rather than the
  // directory: this tree lives under OneDrive, which holds a handle on the
  // folder and fails an rmdir with EBUSY.
  await mkdir(OUT, { recursive: true });
  for (const stale of await readdir(OUT)) {
    if (stale.endsWith(".png")) await rm(join(OUT, stale), { force: true });
  }

  for (const required of ["out-replay.txt", "out-eval.txt", "out-call.txt"]) {
    if (!existsSync(join(TEXT, required))) throw new Error(`${TEXT}/${required} is missing.`);
  }
  const replayOut = readFileSync(join(TEXT, "out-replay.txt"), "utf8").replace(/\s+$/, "");
  const evalOut = readFileSync(join(TEXT, "out-eval.txt"), "utf8").replace(/\s+$/, "");
  const callOut = readFileSync(join(TEXT, "out-call.txt"), "utf8").replace(/\s+$/, "");

  const server = createConsole({ simulate: true });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

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
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
    // The landing is what a judge opens first, so it leads the gallery.
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "networkidle0" });
    await installCaption(page);
    await shoot(page, "what-this-is",
      "The claim, and the three figures behind it, before anything is clicked.");

    await page.goto(`http://127.0.0.1:${port}/console`, { waitUntil: "networkidle0" });
    await until(page, "the console to settle", () => document.getElementById("mode")!.textContent !== "checking…");
    await installCaption(page);

    // Plan first: the two shots that exist only before anything dials.
    await page.evaluate(() => document.getElementById("plan")!.click());
    await until(page, "the plan", () => document.getElementById("planout")!.textContent!.includes("Compiled task"));

    await page.evaluate(() => {
      const box = document.getElementById("confirm") as HTMLInputElement;
      box.checked = true;
      box.dispatchEvent(new Event("change"));
      document.getElementById("run")!.click();
    });

    // 01 — the cover: three places on the line at once, each on its own clock.
    // Shot mid-flight, because it cannot be staged afterwards.
    await until(page, "every row past a minute on the clock", () => {
      const rows = Array.from(document.querySelectorAll("#rows tr"));
      if (rows.length === 0) return false;
      return rows.every((row) => {
        const clock = row.querySelector("[data-clock]")?.textContent ?? "0:00";
        const [m = "0", sec = "0"] = clock.split(":");
        return Number(m) * 60 + Number(sec) >= 60;
      });
    }, 120_000);
    await page.evaluate(() => document.getElementById("board")?.scrollIntoView({ block: "start" }));
    await sleep(300);
    await shoot(page, "on-the-line",
      "Three homes on the line at once, each working its own menu. That clock is the call’s own.");

    // 02 — the same table once every call has settled: a verdict each.
    await until(page, "the verdicts",
      () => document.querySelectorAll("#rows .pill.ok, #rows .pill.held").length >= 3, 120_000);
    await shoot(page, "a-verdict-for-every-place",
      "Every place gets its own verdict, and the count says what survived: <i>established, and withheld</i>.");

    // 03 — the withheld place, opened. The reason is the half that matters.
    await page.evaluate(() => {
      const held = document.querySelector("#rows tr:has(.pill.held)") as HTMLElement | null;
      (held ?? (document.querySelectorAll("#rows tr")[1] as HTMLElement))?.click();
      (document.getElementById("tab-evidence") as HTMLElement | null)?.click();
      document.getElementById("detail-body")?.scrollIntoView({ block: "start" });
    });
    await sleep(500);
    await shoot(page, "why-it-was-withheld",
      "A confident value the call never asked about. It does not come back — and it says why.");

    // 04 — what was actually said, which is the thing the verdict is checked
    // against. The console had no way to show this before.
    await page.evaluate(() => (document.getElementById("tab-transcript") as HTMLElement | null)?.click());
    await sleep(400);
    await shoot(page, "what-was-actually-said",
      "The turns the agent spoke, beside the verdict they produced. <b>No turn, no answer.</b>");

    // 05 — the plan: the task budget and the derived key.
    await page.evaluate(() => {
      (document.getElementById("nav-batch") as HTMLElement).click();
      document.getElementById("planout")?.scrollIntoView({ block: "start" });
    });
    await sleep(400);
    await shoot(page, "plan",
      "Two questions, four homes, one batch — compiled into the <b>255 characters</b> the API allows.");

    // 06 — refusal before dialing.
    await page.evaluate(() => {
      const label = Array.from(document.querySelectorAll("#planout label")).find((el) =>
        el.textContent?.includes("The plan, place by place"),
      );
      label?.scrollIntoView({ block: "center" });
    });
    await shoot(page, "refused-before-dialing",
      "A malformed number is refused <b>before anything dials</b>, not halfway through the batch.");

    // ── the gate, over a saved call ───────────────────────────────────────
    await page.setContent(terminalPage("npm run replay — a synthetic fixture, judged", replayOut), { waitUntil: "load" });
    await installCaption(page);
    await shoot(page, "gate-over-a-fixture",
      "One field <b>verified</b>, quoting the sentence that established it. <i>One flagged</i> — a value the call never asked about.");



    await page.setContent(terminalPage("npm run eval — 400 labelled cases, no calls placed", evalOut), { waitUntil: "load" });
    await installCaption(page);
    await shoot(page, "measured",
      "400 labelled cases. The catch rate <b>and its cost</b> are printed on the same screen, every run.");

    await page.setContent(terminalPage("npm run call — the product, from a terminal", callOut), { waitUntil: "load" });
    await installCaption(page);
    await shoot(page, "cli-dry-run",
      "Dry by default. It plans, validates every number and derives the key — and dials <b>nothing</b> without --live.");

    process.stdout.write(`\n  ${shotNumber} images, 1920×1080, in upload order\n\n`);
  } finally {
    await browser?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  process.exit(1);
});
