import { describe, expect, it } from "vitest";
import { redact, redactError, redactText } from "../src/core/redact.js";

describe("redact", () => {
  it("masks a phone number embedded in free text", () => {
    expect(redactText("Called +14155550199 and got voicemail")).toBe(
      "Called +14••••99 and got voicemail",
    );
  });

  it("masks every phone field in a nested structure", () => {
    // The bug this pins: a number masked in one field and raw in the next,
    // because masking was applied per call site instead of at the boundary.
    const input = {
      maskedPhone: "+14••••99",
      metadata: { contact_phone: "+14155550199" },
      recipients: [{ phones: ["+14155550199", "+442079460958"] }],
    };
    expect(redact(input)).toEqual({
      maskedPhone: "+14••••99",
      metadata: { contact_phone: "+14••••99" },
      recipients: [{ phones: ["+14••••99", "+44••••58"] }],
    });
  });

  it("replaces secret-bearing keys whatever their shape", () => {
    expect(redact({ apiKey: "iams_live_x", Authorization: "Bearer y", nested: { access_token: 1 } })).toEqual(
      { apiKey: "[redacted]", Authorization: "[redacted]", nested: { access_token: "[redacted]" } },
    );
  });

  it("does not mutate its input", () => {
    const input = { metadata: { phone: "+14155550199" } };
    redact(input);
    expect(input.metadata.phone).toBe("+14155550199");
  });

  it("survives a cycle instead of throwing on the error path", () => {
    const cyclic: Record<string, unknown> = { phone: "+14155550199" };
    cyclic["self"] = cyclic;
    expect(redact(cyclic)).toEqual({ phone: "+14••••99", self: "[circular]" });
  });
});

describe("redactError", () => {
  it("redacts the message and the provider details", () => {
    const error = Object.assign(new Error("call to +14155550199 failed"), {
      code: "provider_unavailable",
      status: 503,
      details: { request: { phone: "+14155550199" } },
    });
    expect(redactError(error)).toEqual({
      name: "Error",
      message: "call to +14••••99 failed",
      code: "provider_unavailable",
      status: 503,
      details: { request: { phone: "+14••••99" } },
    });
  });

  it("handles a thrown non-Error", () => {
    expect(redactError("boom +14155550199")).toEqual({
      name: "NonError",
      value: "boom +14••••99",
    });
  });
});

describe("numbers spoken rather than written", () => {
  // Found by a live call, not by this suite. The carrier's IVR read our own
  // outbound caller id back to us and the transcript kept it in national
  // notation, which the E.164 pattern does not match. It reached the file the
  // tool calls shareable. These are the notations that reached us or plausibly
  // will; the numbers below are fictional.
  it.each([
    ["I see you're calling from (555) 433-7012. If you'd like", "(555) 433-7012"],
    ["call 555-433-7012 back", "555-433-7012"],
    ["dial 555.433.7012 now", "555.433.7012"],
    ["reach us at 1-800-555-0199 anytime", "1-800-555-0199"],
  ])("masks %j", (text, leaked) => {
    const out = redactText(text);
    expect(out).not.toContain(leaked);
    expect(out).toContain("[redacted-phone]");
  });

  it("leaves a bare digit run alone, so a tracking number survives", () => {
    // Separators are required precisely so this does not become a shredder.
    const text = "your tracking number is 771234567890";
    expect(redactText(text)).toBe(text);
  });
});
