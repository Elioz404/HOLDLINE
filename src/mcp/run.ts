/**
 * `npm run mcp` — serve HOLDLINE's tools over stdio.
 *
 * Nothing is written to stdout except the MCP protocol itself; stdio transport
 * uses that stream, and a stray `console.log` corrupts the session. Diagnostics
 * go to stderr.
 */

import { main } from "./server.js";

main().catch((error: unknown) => {
  process.stderr.write(`holdline mcp failed to start: ${String(error)}\n`);
  process.exit(1);
});
