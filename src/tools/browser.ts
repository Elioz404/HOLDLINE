/// <reference lib="dom" />
/**
 * The bits `video.ts` and `gallery.ts` both need: finding the installed
 * Chrome, waiting for a state rather than sleeping and hoping, the caption bar
 * drawn into the page, and the terminal page that shows real captured output.
 *
 * Both tools render at a 1280×720 layout with a 1.5 device pixel ratio, so
 * everything they produce is 1920×1080 and the type stays large relative to
 * the frame. Keeping that in one place is why the stills and the video look
 * like they belong to each other.
 *
 * The DOM lib is referenced here because the callbacks below are serialised
 * and run inside the browser.
 */

import { existsSync } from "node:fs";
import type { Page } from "puppeteer-core";

export const FRAME = { width: 1280, height: 720, deviceScaleFactor: 1.5 } as const;

const CHROME_CANDIDATES = [
  process.env["CHROME_PATH"],
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter((path): path is string => typeof path === "string");

export function findChrome(): string {
  const found = CHROME_CANDIDATES.find((path) => existsSync(path));
  if (!found) throw new Error(`No Chrome found. Set CHROME_PATH. Looked in:\n  ${CHROME_CANDIDATES.join("\n  ")}`);
  return found;
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll until `check` passes in the page, or fail with something readable. */
export async function until(page: Page, what: string, check: () => boolean, timeoutMs = 60_000): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (await page.evaluate(check)) return;
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for: ${what}`);
    await sleep(100);
  }
}

const CAPTION_CSS = `
#vcap {
  position: fixed; left: 0; right: 0; bottom: 0; z-index: 2147483647;
  padding: 26px 56px 30px;
  background: linear-gradient(to top, rgba(6,9,12,.96) 62%, rgba(6,9,12,0));
  font: 500 27px/1.42 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  color: #f2f6fa; letter-spacing: -0.011em; text-wrap: balance;
  opacity: 0; transition: opacity .24s ease;
}
#vcap.on { opacity: 1; }
#vcap b { color: #7ee2b8; font-weight: 650; }
#vcap i { color: #ff9f8f; font-style: normal; font-weight: 650; }
`;

export async function installCaption(page: Page): Promise<void> {
  await page.evaluate((css: string) => {
    if (document.getElementById("vcap")) return;
    const style = document.createElement("style");
    style.textContent = css;
    document.head.appendChild(style);
    const bar = document.createElement("div");
    bar.id = "vcap";
    document.body.appendChild(bar);
  }, CAPTION_CSS);
}

export async function setCaption(page: Page, html: string): Promise<void> {
  await page.evaluate((text: string) => {
    const bar = document.getElementById("vcap")!;
    bar.innerHTML = text;
    bar.classList.add("on");
  }, html);
}

export async function clearCaption(page: Page): Promise<void> {
  await page.evaluate(() => document.getElementById("vcap")!.classList.remove("on"));
}

/** A page that shows real captured terminal output. Nothing here is invented. */
export function terminalPage(title: string, body: string): string {
  const escaped = body.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  // Long output has to shrink or it runs under the caption, and a still image
  // cannot be scrolled. Measured against the frame rather than guessed: the
  // pane is 720px tall, the header takes 40 of them, and the caption sits in
  // the bottom 90.
  const lines = body.split("\n").length;
  const size = lines > 26 ? 11.5 : 14;
  const leading = lines > 26 ? 1.42 : 1.5;
  return `<!doctype html><meta charset="utf-8"><style>
    :root { color-scheme: dark; }
    body { margin: 0; background: #06090c; color: #d7e2ec; height: 100vh; overflow: hidden;
           font: 400 ${size}px/${leading} ui-monospace, "Cascadia Code", "JetBrains Mono", Consolas, monospace; }
    header { padding: 26px 56px 8px; font: 600 15px ui-sans-serif, system-ui, sans-serif;
             letter-spacing: .16em; text-transform: uppercase; color: #7d8b99; }
    /*
     * pre-wrap, not pre. Real tool output contains quoted transcript turns
     * that run past 1280px, and pre clips them at the frame edge — a still
     * image cannot be scrolled, so the end of the sentence is simply lost. The
     * hanging indent keeps a wrapped line reading as a continuation rather
     * than as a new column. (No backticks in here: this whole block is inside
     * a template literal.)
     */
    pre { margin: 0; padding: 2px 56px; white-space: pre-wrap; }
  </style>
  <header>${title}</header>
  <pre>${escaped}</pre>`;
}
