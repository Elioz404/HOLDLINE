/**
 * Output redaction.
 *
 * The failure this module exists to prevent: a phone number masked in one field
 * and returned raw in the field next to it, because the masking was applied at
 * the call site instead of at the boundary. Everything that leaves this engine
 * — results, metadata echoed back by the provider, and error payloads — goes
 * through `redact` first.
 */

import { maskPhone } from "./phone.js";

/** Matches an E.164-shaped run anywhere inside a larger string. */
const EMBEDDED_E164 = /\+[1-9]\d{7,14}/g;

/**
 * Matches a number written the way somebody says one out loud.
 *
 * A live call found this gap rather than a test: the carrier's IVR read our
 * own outbound caller id back to us, the transcript recorded it in national
 * notation, and the pattern above did not see a phone number at all —
 * so a full number reached a file this tool calls shareable. Masking that
 * claimed to cover "every number in every response" covered one notation.
 *
 * Separators are required, so a bare run of digits — a tracking number, an
 * order id, a reference — is left alone. A transcript is free text, and the
 * safe direction here is the same one the gate takes: over-withhold rather
 * than let one through.
 */
const EMBEDDED_NATIONAL = /(?:\+?1[-.\s])?\(?\b\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/g;

/**
 * Keys whose values are replaced wholesale rather than pattern-matched.
 * Compared case-insensitively against the key's normalized form.
 */
const SECRET_KEYS = new Set([
  "apikey",
  "api_key",
  "authorization",
  "password",
  "secret",
  "token",
  "accesstoken",
  "access_token",
  "refreshtoken",
  "refresh_token",
  "cookie",
  "setcookie",
  "set_cookie",
]);

const normalizeKey = (key: string): string => key.toLowerCase().replace(/[-\s]/g, "");

/**
 * Replace every phone-shaped run inside a free-text string with its mask.
 *
 * E.164 first, so a well-formed number keeps the partial mask that lets an
 * operator tell two targets apart. Anything else phone-shaped falls through to
 * `maskPhone`, which refuses to guess and returns `[redacted-phone]`.
 */
export function redactText(value: string): string {
  return value
    .replace(EMBEDDED_E164, (match) => maskPhone(match))
    .replace(EMBEDDED_NATIONAL, (match) => maskPhone(match));
}

/**
 * Walk any JSON-like value and return a redacted copy.
 *
 * - Strings have embedded phone numbers masked.
 * - Values under a known secret key become `"[redacted]"` regardless of shape.
 * - Objects and arrays are copied, not mutated.
 * - Cycles are replaced with `"[circular]"` rather than throwing, because this
 *   runs on the error path and must not fail there.
 *
 * Non-JSON values (functions, symbols) are dropped, matching `JSON.stringify`.
 */
export function redact<T>(value: T): unknown {
  return walk(value, new WeakSet<object>());
}

function walk(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "string") return redactText(value);
  if (value === null || typeof value !== "object") {
    return typeof value === "function" || typeof value === "symbol" ? undefined : value;
  }

  if (seen.has(value)) return "[circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => walk(item, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_KEYS.has(normalizeKey(key))) {
      out[key] = "[redacted]";
      continue;
    }
    const walked = walk(item, seen);
    if (walked !== undefined) out[key] = walked;
  }
  return out;
}

/**
 * Render any thrown value as a redacted, log-safe object.
 *
 * Provider error bodies are the classic leak: they quote the request back,
 * phone number included. Nothing here stringifies an unredacted body.
 */
export function redactError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const extra: Record<string, unknown> = {};
    for (const key of ["code", "status", "details"] as const) {
      const value = (error as unknown as Record<string, unknown>)[key];
      if (value !== undefined) extra[key] = redact(value);
    }
    return {
      name: error.name,
      message: redactText(error.message),
      ...extra,
    };
  }
  return { name: "NonError", value: redact(error) };
}
