import { describe, expect, it } from "vitest";
import { checkPhone, isE164, maskPhone } from "../src/core/phone.js";

describe("E.164 validation", () => {
  it("accepts a well-formed number", () => {
    expect(checkPhone("+14155550199")).toEqual({ ok: true, e164: "+14155550199" });
  });

  it("accepts the shortest and longest legal lengths", () => {
    expect(isE164("+12345678")).toBe(true); // 8 digits
    expect(isE164("+123456789012345")).toBe(true); // 15 digits
  });

  it("rejects numbers outside the 8-15 digit range", () => {
    expect(checkPhone("+1234567")).toEqual({ ok: false, reason: "not_e164" }); // 7
    expect(checkPhone("+1234567890123456")).toEqual({ ok: false, reason: "not_e164" }); // 16
  });

  it("rejects a leading zero after the plus", () => {
    // A country code never starts with 0. This is the check a permissive
    // regex misses, and it lets undialable numbers through to live mode.
    expect(checkPhone("+01415555267")).toEqual({ ok: false, reason: "not_e164" });
  });

  it("rejects formatting humans type", () => {
    expect(checkPhone("+1 415 555 2671")).toEqual({ ok: false, reason: "contains_whitespace" });
    expect(checkPhone("+14155550199ext22")).toEqual({ ok: false, reason: "contains_extension" });
    expect(checkPhone("+14155550199,,1")).toEqual({ ok: false, reason: "contains_extension" });
    expect(checkPhone("14155550199")).toEqual({ ok: false, reason: "not_e164" });
    expect(checkPhone("")).toEqual({ ok: false, reason: "empty" });
  });

  it("refuses obvious placeholders", () => {
    expect(checkPhone("+15555555555")).toEqual({ ok: false, reason: "placeholder" });
  });

  it("refuses emergency and crisis lines regardless of configuration", () => {
    expect(checkPhone("+19110000000")).toEqual({ ok: false, reason: "blocked_prefix" });
    expect(checkPhone("+19889999999")).toEqual({ ok: false, reason: "blocked_prefix" });
  });
});

describe("masking", () => {
  it("keeps exactly the leading plus, first two digits, and last two", () => {
    // The docstring promises this and nothing more. If the promise changes,
    // this test fails before the README goes stale.
    expect(maskPhone("+14155550199")).toBe("+14••••99");
  });

  it("does not encode the original length in the mask", () => {
    // An 8-digit and a 15-digit number must produce masks of the same width,
    // or the mask leaks how long the number was.
    const short = maskPhone("+12345678");
    const long = maskPhone("+123456789012345");
    expect(short).toHaveLength(long.length);
    expect(short).toBe("+12••••78");
    expect(long).toBe("+12••••45");
  });

  it("masks a malformed number rather than passing it through", () => {
    expect(maskPhone("415-555-2671")).toBe("[redacted-phone]");
    expect(maskPhone("")).toBe("[redacted-phone]");
  });
});
