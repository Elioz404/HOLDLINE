import { describe, expect, it } from "vitest";

import { SUPPORTED_REGIONS, regionForNumber, regionsSpeaking } from "../src/core/regions.js";

/**
 * These pin the transcription of CALL-E's supported-regions table. If the
 * provider adds or drops a territory, this file is stale — the test failing is
 * the reminder to re-read the table, not a bug in the code.
 */
describe("supported regions", () => {
  it("carries the whole published table", () => {
    expect(SUPPORTED_REGIONS.length).toBe(42);
  });

  it("matches a number to its region", () => {
    expect(regionForNumber("+14155550199")?.code).toBe("US");
    expect(regionForNumber("+525555550199")?.code).toBe("MX");
    expect(regionForNumber("+34555550199")?.code).toBe("ES");
  });

  it("prefers the longer dialing prefix", () => {
    // +504 must not be swallowed by +5, and +1 must not swallow +1... nothing.
    expect(regionForNumber("+50455501990")?.code).toBe("HN");
  });

  /**
   * The failure that produced this module: a real attempt to call an Argentine
   * number was rejected by the API with a message suggesting a language could
   * fix it. It cannot — Argentina is not on the list in any language.
   *
   * The number here is deliberately impossible. The real one belonged to a
   * person, and the repository refuses to hold it.
   */
  it("knows Argentina is not callable", () => {
    expect(regionForNumber("+545555555555")).toBeNull();
    expect(SUPPORTED_REGIONS.some((r) => r.country.toLowerCase().includes("argentin"))).toBe(false);
  });

  it("can name where a language is available", () => {
    const spanish = regionsSpeaking("Spanish").map((r) => r.code).sort();
    expect(spanish).toEqual(["ES", "HN", "MX"]);
  });

  it("is case-insensitive about the language", () => {
    expect(regionsSpeaking("spanish").length).toBe(regionsSpeaking("Spanish").length);
  });
});
