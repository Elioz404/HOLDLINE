/**
 * Phone number handling.
 *
 * Two jobs, kept deliberately separate: decide whether a string is dialable,
 * and decide what a number is allowed to look like once it leaves this process.
 */

/**
 * E.164: a leading `+`, a first digit of 1-9, and 8 to 15 digits in total.
 *
 * The upper bound is the ITU limit. The lower bound rejects the short strings
 * that look plausible in a spreadsheet and are not dialable. A leading zero
 * after the `+` is not a country code and is rejected.
 */
const E164 = /^\+[1-9]\d{7,14}$/;

/** Obvious placeholders that must never reach the dialer, even in live mode. */
const PLACEHOLDERS = new Set([
  "+10000000000",
  "+11111111111",
  "+12345678901",
  "+15555555555",
]);

export type PhoneRejection =
  | "empty"
  | "contains_whitespace"
  | "contains_extension"
  | "not_e164"
  | "placeholder"
  | "blocked_prefix";

export type PhoneCheck =
  | { ok: true; e164: string }
  | { ok: false; reason: PhoneRejection };

/**
 * Numbers this engine refuses to dial regardless of configuration.
 *
 * Emergency and crisis lines are not a policy toggle. A phone agent that can
 * reach them by misconfiguration is a phone agent that will, eventually.
 */
const BLOCKED_PREFIXES = [
  "+1911",
  "+1988", // US/CA suicide & crisis lifeline
  "+112", // EU emergency
  "+999",
];

export function checkPhone(raw: string): PhoneCheck {
  if (!raw) return { ok: false, reason: "empty" };
  if (/\s/.test(raw)) return { ok: false, reason: "contains_whitespace" };
  if (/(ext|x|#|,|;)/i.test(raw.slice(1))) {
    return { ok: false, reason: "contains_extension" };
  }
  if (!E164.test(raw)) return { ok: false, reason: "not_e164" };
  if (PLACEHOLDERS.has(raw)) return { ok: false, reason: "placeholder" };
  if (BLOCKED_PREFIXES.some((p) => raw.startsWith(p))) {
    return { ok: false, reason: "blocked_prefix" };
  }
  return { ok: true, e164: raw };
}

export function isE164(raw: string): boolean {
  return checkPhone(raw).ok;
}

/**
 * Mask a phone number for logs, reports, and anything a person can read.
 *
 * The masked form keeps **the leading `+`, the first two digits, and the last
 * two digits**; everything between becomes a run of bullets whose length does
 * not encode the original length. `+14155550199` becomes `+14••••99`.
 *
 * That is the whole guarantee. It is not reversible, it does not preserve the
 * country code (a country code can be one to three digits), and it is not a
 * substitute for not logging the number at all.
 *
 * A string that is not E.164 is masked as `[redacted-phone]` rather than
 * passed through, so a malformed number cannot leak by failing the check.
 */
export function maskPhone(raw: string): string {
  if (!E164.test(raw)) return "[redacted-phone]";
  const head = raw.slice(0, 3); // "+" + first two digits
  const tail = raw.slice(-2);
  return `${head}••••${tail}`;
}
