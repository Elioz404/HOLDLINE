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
