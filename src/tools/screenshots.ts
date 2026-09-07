/// <reference lib="dom" />
/**
 * `npm run screenshots` — capture the console into `docs/screenshots/`.
 *
 * The DOM lib is referenced for this file alone: the callbacks passed to
 * `page.evaluate` are serialised and run inside the browser, so they need
 * browser types. The rest of the project stays Node-only on purpose.
 *
 * Reproducible rather than hand-taken: it starts the console in-process,
 * drives a real Chrome, and waits for the states worth showing instead of
 * sleeping and hoping. Re-run it whenever the interface changes and the images
 * in the README stay true.
 *
 * It uses `puppeteer-core` against the Chrome already on the machine, so
 * nothing downloads a second browser. Set `CHROME_PATH` if yours lives
 * somewhere unusual.
 *
 * Simulation only. It never places a call and never needs a key.
 */

import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";

import { createConsole } from "../console/server.js";

const OUT = "docs/screenshots";

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
  if (!found) {
    throw new Error(
      `No Chrome found. Set CHROME_PATH to its executable. Looked in:\n  ${CHROME_CANDIDATES.join("\n  ")}`,
    );
  }
  return found;
}

/** Poll the page until `check` returns true, or give up with a useful message. */
async function until(page: Page, what: string, check: () => boolean, timeoutMs = 20_000): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (await page.evaluate(check)) return;
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
}

/**
 * Frame one element rather than the whole page.
 *
 * A full-page shot of this console is mostly the input form. What a reader
 * needs to see is the output: the compiled task, the board, the verdicts.
 */
async function shoot(page: Page, selector: string, name: string): Promise<void> {
  const element = await page.$(selector);
  if (!element) throw new Error(`Nothing to photograph at ${selector}`);
  await element.scrollIntoView();
  const path = join(OUT, `${name}.png`) as `${string}.png`;
  await element.screenshot({ path });
  process.stdout.write(`  ${path}\n`);
}

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });

  const server = createConsole({ simulate: true });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  let browser: Browser | undefined;
  try {
    browser = await puppeteer.launch({
      executablePath: findChrome(),
      headless: true,
      args: ["--force-color-profile=srgb", "--hide-scrollbars"],
    });
    const page = await browser.newPage();
    // Retina-scale so the text stays crisp when GitHub scales the image down.
    await page.setViewport({ width: 1280, height: 940, deviceScaleFactor: 2 });
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);

    await page.goto(`http://127.0.0.1:${port}`, { waitUntil: "networkidle0" });
    await until(page, "the mode badge to resolve", () =>
      document.getElementById("mode")!.textContent !== "checking…",
    );

    // 1 — the plan: compiled task, character budget, masked numbers, the
    //     number refused before anything dialed.
    await page.click("#plan");
    await until(page, "the plan to render", () =>
      document.getElementById("planout")!.textContent!.includes("Compiled task"),
    );
    await shoot(page, "#planout .panel", "plan");

    // 2 — the wait. Three homes in the queue at once with the call clock
    //     climbing. This is the one the video is built around.
    await page.evaluate(() => {
      const box = document.getElementById("confirm") as HTMLInputElement;
      box.checked = true;
      box.dispatchEvent(new Event("change"));
      document.getElementById("run")!.click();
    });
    await until(page, "every row to be holding past a minute", () => {
      const rows = Array.from(document.querySelectorAll(".liverow"));
      if (rows.length === 0) return false;
      return rows.every((row) => {
        const phase = row.querySelector("[data-phase]")?.textContent;
        const clock = row.querySelector("[data-clock]")?.textContent ?? "0:00";
        const [m = "0", s = "0"] = clock.split(":");
        return phase === "holding" && Number(m) * 60 + Number(s) >= 60;
      });
    });
    await shoot(page, "#board", "holding");

    // 3 — the verdicts: one verified with the sentence that established it,
    //     one withheld with the reason.
    await until(page, "every verdict to land", () =>
      document.querySelectorAll("#cards .card").length >= 3,
    );
    await page.evaluate(() => {
      document.querySelector("#cards")?.scrollIntoView({ block: "start" });
    });
    await shoot(page, "#outcome", "verdicts");

    // Guard: a screenshot that leaks a real number is worse than no screenshot.
    const leaked = await page.evaluate(() => {
      // innerText does not include what is typed into a textarea, and that is
      // exactly where an operator's own numbers would sit.
      const typed = Array.from(document.querySelectorAll("textarea, input"))
        .map((field) => (field as HTMLInputElement).value)
        .join(" ");
      // The reserved +1555 fiction block is allowed; anything else is not.
      const candidates = `${document.body.innerText} ${typed}`.match(/\+\d{8,15}/g) ?? [];
      return candidates.some((n) => !/^\+1\d{0,3}555\d{4,7}$/.test(n));
    });
    if (leaked) {
      throw new Error("An unmasked phone number is visible on the page. Not shipping these images.");
    }
  } finally {
    await browser?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  process.exit(1);
});
