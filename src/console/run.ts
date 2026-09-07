/**
 * `npm run console` — serve the operations console on loopback.
 *
 * Simulation unless both `CALLE_API_KEY` and `HOLDLINE_CONSOLE_LIVE=1` are set.
 * The bind address is deliberately `127.0.0.1`: this view shows call
 * transcripts and has no authentication of its own.
 */

import { createConsole } from "./server.js";

const port = Number(process.env["HOLDLINE_CONSOLE_PORT"] ?? 4173);
const live = process.env["HOLDLINE_CONSOLE_LIVE"] === "1" && Boolean(process.env["CALLE_API_KEY"]);

createConsole().listen(port, "127.0.0.1", () => {
  process.stdout.write(
    `HOLDLINE console on http://127.0.0.1:${port}  —  ${live ? "LIVE: calls will be placed" : "simulation: no telephone involved"}\n`,
  );
});
