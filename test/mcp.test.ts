import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

/**
 * These drive a real MCP client against a real MCP server over a linked
 * in-memory transport. Nothing is stubbed but the network underneath CALL-E.
 *
 * The module reads `HOLDLINE_SIMULATE` at import time, so the environment is
 * set before the dynamic import and the module registry is reset between
 * suites.
 */
async function connect(): Promise<{ client: Client; close: () => Promise<void> }> {
  const { createServer } = await import("../src/mcp/server.js");
  const server = createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

const textOf = (result: unknown): string => {
  const content = (result as { content: { type: string; text?: string }[] }).content;
  return content.map((part) => part.text ?? "").join("");
};

const jsonOf = (result: unknown): Record<string, unknown> =>
  JSON.parse(textOf(result)) as Record<string, unknown>;

const isError = (result: unknown): boolean => (result as { isError?: boolean }).isError === true;

const TARGETS = [
  { subjectId: "clinic-7", phone: "+15550199001", label: "Northside Clinic" },
  { subjectId: "clinic-8", phone: "+15550199007" },
];

const FIELDS = [
  { name: "accepts_new_patients", asks: ["new patients", "accepting new"], required: true },
];

const baseArgs = {
  goal: "Ask whether the practice is accepting new patients this month.",
  routingHint: "Reach the front desk.",
  targets: TARGETS,
  fields: FIELDS,
  workflow: "intake",
  intent: "capacity-check",
  batchId: "batch-2026-09-07",
};

describe("MCP server", () => {
  beforeEach(() => {
    process.env["HOLDLINE_SIMULATE"] = "1";
    vi.resetModules();
  });
  afterEach(() => {
    delete process.env["HOLDLINE_SIMULATE"];
  });

  it("exposes exactly the three documented tools", async () => {
    const { client, close } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["get_verdict", "plan_hold", "run_hold"]);
    await close();
  });

  it("marks the dialing tool as the only non-read-only one", async () => {
    const { client, close } = await connect();
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));

    expect(byName["plan_hold"]?.readOnlyHint).toBe(true);
    expect(byName["get_verdict"]?.readOnlyHint).toBe(true);
    expect(byName["run_hold"]?.readOnlyHint).toBe(false);
    expect(byName["run_hold"]?.destructiveHint).toBe(true);
    await close();
  });

  it("plans without dialing and masks every number it reports", async () => {
    const { client, close } = await connect();
    const body = jsonOf(await client.callTool({ name: "plan_hold", arguments: baseArgs }));

    expect(body["idempotencyKey"]).toMatch(/^hl1_[0-9a-f]{32}$/);
    expect(String(body["taskChars"])).toMatch(/^\d+\/255$/);
    expect(body["note"]).toContain("Nothing was dialed");

    const dialable = body["dialable"] as { phone: string }[];
    expect(dialable).toHaveLength(2);
    for (const target of dialable) {
      expect(target.phone).toMatch(/^\+\d{2}••••\d{2}$/);
    }
    // The raw numbers appear nowhere in the payload.
    expect(textOf(await client.callTool({ name: "plan_hold", arguments: baseArgs }))).not.toContain(
      "+15550199001",
    );
    await close();
  });

  it("separates undialable targets in the plan", async () => {
    const { client, close } = await connect();
    const body = jsonOf(
      await client.callTool({
        name: "plan_hold",
        arguments: {
          ...baseArgs,
          targets: [
            { subjectId: "ok", phone: "+15550199001" },
            { subjectId: "emergency", phone: "+19110000000" },
          ],
        },
      }),
    );

    expect((body["dialable"] as unknown[]).length).toBe(1);
    expect(body["rejected"]).toEqual([
      { subjectId: "emergency", maskedPhone: "+19••••00", reason: "blocked_prefix" },
    ]);
    await close();
  });

  it("refuses to dial without confirm, and says so plainly", async () => {
    const { client, close } = await connect();
    const result = await client.callTool({
      name: "run_hold",
      arguments: { ...baseArgs, confirm: false },
    });

    expect(isError(result)).toBe(true);
    const body = jsonOf(result);
    expect(body["refused"]).toBe("confirm was not true");
    expect(String(body["note"])).toContain("real phone calls");
    await close();
  });

  it("labels every simulated response so it cannot pass as a real call", async () => {
    const { client, close } = await connect();
    const body = jsonOf(await client.callTool({ name: "plan_hold", arguments: baseArgs }));
    expect(body["simulated"]).toBe(true);
    expect(String(body["notice"])).toContain("no telephone was involved");
    await close();
  });

  it("dials with confirm and gates each target's answer", async () => {
    const { client, close } = await connect();
    const body = jsonOf(
      await client.callTool({ name: "run_hold", arguments: { ...baseArgs, confirm: true } }),
    );

    expect(body["outcome"]).toBe("completed");
    expect(body["simulated"]).toBe(true);
    const targets = body["targets"] as { subjectId: string; verdict: string; phone: string }[];
    expect(targets).toHaveLength(1); // the ivr_traversal scenario has one recipient
    expect(targets[0]?.phone).toMatch(/^\+\d{2}••••\d{2}$/);
    await close();
  });
});

describe("MCP server without credentials", () => {
  beforeEach(() => {
    delete process.env["HOLDLINE_SIMULATE"];
    delete process.env["CALLE_API_KEY"];
    vi.resetModules();
  });

  it("explains what is missing instead of failing obscurely", async () => {
    const { client, close } = await connect();
    const result = await client.callTool({
      name: "run_hold",
      arguments: { ...baseArgs, confirm: true },
    });

    expect(isError(result)).toBe(true);
    const message = String((jsonOf(result)["error"] as { message?: string })?.message ?? "");
    expect(message).toContain("CALLE_API_KEY is not set");
    expect(message).toContain("HOLDLINE_SIMULATE=1");
    await close();
  });

  it("still plans, because planning needs no network", async () => {
    const { client, close } = await connect();
    const body = jsonOf(await client.callTool({ name: "plan_hold", arguments: baseArgs }));
    expect(body["idempotencyKey"]).toMatch(/^hl1_/);
    expect(body["simulated"]).toBeUndefined();
    await close();
  });
});
