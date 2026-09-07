import { describe, expect, it } from "vitest";
import { CalleClient } from "@call-e/calle";

import { InMemoryDispatchRegistry, handleWebhook } from "../src/engine/webhook.js";
import { SCENARIOS, createFakeCalle } from "../src/testing/fake-calle.js";

/**
 * CALL-E webhook deliveries are unsigned — the SDK says so itself, deprecating
 * its signature helpers with that reason. Every test here is about what an
 * unauthenticated endpoint is allowed to believe.
 */
async function setup(scenario = SCENARIOS.ivr_traversal) {
  const fake = createFakeCalle({ scenario });
  const client = new CalleClient({ apiKey: "iams_test_key", fetch: fake.fetch });
  const registry = new InMemoryDispatchRegistry();
  const created = await client.calls.create({ task: "Reach account services." });
  registry.register(created.id);
  return { fake, client, registry, callId: created.id };
}

describe("webhook receiver", () => {
  it("refuses a call id this application never dispatched", async () => {
    const { client, registry } = await setup();
    const result = await handleWebhook(JSON.stringify({ call_id: "call_someone_elses" }), {
      client,
      registry,
    });

    expect(result.verdict).toBe("unknown_call");
    expect(result.call).toBeNull();
  });

  it("ignores a body that is not JSON instead of throwing", async () => {
    const { client, registry } = await setup();
    const result = await handleWebhook("<html>nope</html>", { client, registry });
    expect(result.verdict).toBe("unparseable");
  });

  it("ignores a body with no recognizable call id", async () => {
    const { client, registry } = await setup();
    const result = await handleWebhook(JSON.stringify({ hello: "world" }), { client, registry });
    expect(result.verdict).toBe("no_call_id");
  });

  it("rejects a malformed call id without fetching", async () => {
    const { client, registry } = await setup();
    const result = await handleWebhook(
      JSON.stringify({ call_id: "../../etc/passwd" }),
      { client, registry },
    );
    expect(result.verdict).toBe("no_call_id");
  });

  /** The central behaviour: the payload is a doorbell, not a document. */
  it("takes the result from the API and nothing from the payload", async () => {
    const { client, registry, callId } = await setup();

    // A hostile delivery claiming the call completed with an invented result.
    const lie = JSON.stringify({
      call_id: callId,
      status: "completed",
      structured_result: { reference_status: "approved" },
      completion_confidence: { score: 1, label: "high" },
    });

    // First delivery: the call is not terminal yet, and the payload's claim
    // that it completed carries no weight at all.
    const early = await handleWebhook(lie, { client, registry });
    expect(early.verdict).toBe("not_terminal");

    // Once the call really finishes, the fetched result is the real one.
    const settled = await handleWebhook(lie, { client, registry });
    expect(settled.verdict).toBe("processed");
    expect(settled.call?.structuredResult).toEqual({
      reached_department: "yes",
      reference_status: "in_review",
    });
    expect(settled.call?.structuredResult).not.toMatchObject({ reference_status: "approved" });
  });

  it("treats a retried delivery as a no-op", async () => {
    const { client, registry, callId } = await setup();
    const body = JSON.stringify({ data: { id: callId } });

    await handleWebhook(body, { client, registry }); // queued
    await handleWebhook(body, { client, registry }); // terminal, processed
    const third = await handleWebhook(body, { client, registry });

    expect(third.verdict).toBe("duplicate");
  });

  it("does not mark a call processed when the API could not be reached", async () => {
    const registry = new InMemoryDispatchRegistry();
    registry.register("call_unreachable");
    const client = new CalleClient({
      apiKey: "iams_test_key",
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });

    const result = await handleWebhook(JSON.stringify({ call_id: "call_unreachable" }), {
      client,
      registry,
    });

    expect(result.verdict).toBe("fetch_failed");
    expect(result.classification?.class).toBe("reconcile");
    // A retry has to be able to succeed.
    expect(registry.isProcessed("call_unreachable")).toBe(false);
  });

  it("accepts the nested delivery shape as well as the flat one", async () => {
    const { client, registry, callId } = await setup();
    const nested = JSON.stringify({ type: "call.completed", data: { call_id: callId } });

    await handleWebhook(nested, { client, registry });
    const second = await handleWebhook(nested, { client, registry });
    expect(second.verdict).toBe("processed");
  });
});
