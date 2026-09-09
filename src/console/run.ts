/**
 * `npm run console` — serve the operations console.
 *
 * Loopback by default, because this view shows call transcripts and has no
 * authentication of its own. `HOLDLINE_CONSOLE_HOST` moves it, which is what a
 * container needs, and moving it costs the ability to dial:
 *
 *   **A console reachable from anywhere but this machine cannot place calls.**
 *
 * That is enforced here rather than left to whoever writes the deployment
 * config. A public instance with a key in its environment would otherwise let
 * any visitor spend real credits ringing real people, and "we remembered not
 * to set the key" is not a safety property. Binding off loopback forces
 * simulation, whatever else is set.
 *
 * On loopback the old rule stands: live needs `HOLDLINE_CONSOLE_LIVE=1` and
 * `CALLE_API_KEY` together.
 */

import { createConsole } from "./server.js";

/** Render, Fly and friends inject `PORT`. */
const port = Number(process.env["PORT"] ?? process.env["HOLDLINE_CONSOLE_PORT"] ?? 4173);
const host = process.env["HOLDLINE_CONSOLE_HOST"] ?? "127.0.0.1";

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
const reachable = !LOOPBACK.has(host);

const live = !reachable && process.env["HOLDLINE_CONSOLE_LIVE"] === "1" && Boolean(process.env["CALLE_API_KEY"]);

createConsole(reachable ? { simulate: true } : {}).listen(port, host, () => {
  const where = reachable ? `${host}:${port}` : `http://127.0.0.1:${port}`;
  const mode = live
    ? "LIVE: calls will be placed"
    : reachable
      ? "simulation, and locked to it: this console is reachable off this machine"
      : "simulation: no telephone involved";
  process.stdout.write(`HOLDLINE console on ${where}  —  ${mode}\n`);
});
