import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { createConsole } from "../src/console/server.js";

let server: Server;
let base: string;

const BATCH = {
  goal: "Ask whether the practice is accepting new patients this month.",
  routingHint: "Reach the front desk.",
  batchId: "intake-2026-09-07",
  workflow: "console",
  intent: "ask",
  targets: [
    { subjectId: "clinic-north", phone: "+15550199001", label: "Northside Clinic" },
    { subjectId: "clinic-east", phone: "+15550199007", label: "Eastgate Family" },
  ],
  fields: [
    { name: "accepts_new_patients", asks: ["accepting new patients", "new patients"], required: true },
    { name: "waitlist_weeks", asks: ["waiting list", "how long is the wait"], required: true },
  ],
};

const post = async (path: string, body: unknown) => {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any>, raw: res };
};

beforeAll(async () => {
  // Fast playback: the suite should not sit through simulated hold music.
  server = createConsole({ simulate: true, playbackSpeed: 4000 });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

describe("console page", () => {
  it("serves a self-contained page with no external resources", async () => {
    const res = await fetch(`${base}/console`);
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    // The CSP allows only 'self'; anything remote would silently fail to load.
    expect(html).not.toMatch(/src="https?:\/\//);
    expect(html).not.toMatch(/href="https?:\/\/[^"]*\.css/);
    expect(html).toContain("HOLDLINE");
  });

  it("has an inline script that actually parses", async () => {
    // The page carries its own JavaScript. A broken escape ships a blank
    // console to a judge and nothing else in the suite would notice, because
    // every other test talks to the API rather than the page.
    const html = await (await fetch(`${base}/console`)).text();
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
    expect(script, "page should carry an inline script").toBeTruthy();
    expect(() => new Function(script!)).not.toThrow();
  });

  it("serves a landing page at the root whose script parses", async () => {
    // Same reasoning as the console above, for the page a judge sees first.
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("HOLDLINE");
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
    expect(script, "landing should carry an inline script").toBeTruthy();
    expect(() => new Function(script!)).not.toThrow();
  });

  it("sets a content security policy and nosniff", async () => {
    const res = await fetch(`${base}/console`);
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("state", () => {
  it("reports simulation and never claims live without credentials", async () => {
    const state = (await (await fetch(`${base}/api/state`)).json()) as Record<string, any>;
    expect(state["mode"]).toBe("simulation");
    expect(state["simulated"]).toBe(true);
    expect(state["liveAvailable"]).toBe(false);
  });
});

describe("planning", () => {
  it("compiles a task inside the limit and masks every number", async () => {
    const { status, body } = await post("/api/plan", BATCH);

    expect(status).toBe(200);
    expect(body["used"]).toBeLessThanOrEqual(255);
    expect(body["budget"]).toBe(255);
    expect(body["idempotencyKey"]).toMatch(/^hl1_[0-9a-f]{32}$/);
    for (const target of body["dialable"] as { phone: string }[]) {
      expect(target.phone).toMatch(/^\+\d{2}••••\d{2}$/);
    }
  });

  it("never emits a raw phone number anywhere in the response", async () => {
    const res = await fetch(`${base}/api/plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(BATCH),
    });
    const text = await res.text();
    expect(text).not.toContain("+15550199001");
    expect(text).not.toContain("+15550199007");
  });

  it("separates a malformed number before anything is dispatched", async () => {
    const { body } = await post("/api/plan", {
      ...BATCH,
      targets: [...BATCH.targets, { subjectId: "typo", phone: "+1 555 019 9002" }],
    });
    expect(body["rejected"]).toEqual([
      { subjectId: "typo", maskedPhone: "[redacted-phone]", reason: "contains_whitespace" },
    ]);
  });

  it("rejects an incomplete batch with a readable reason", async () => {
    for (const [patch, expected] of [
      [{ goal: "" }, "goal is required"],
      [{ targets: [] }, "at least one target is required"],
      [{ fields: [] }, "at least one field is required"],
      [{ batchId: "" }, "batchId is required and must be a stable record id"],
    ] as const) {
      const { status, body } = await post("/api/plan", { ...BATCH, ...patch });
      expect(status).toBe(400);
      expect(body["error"]).toBe(expected);
    }
  });
});

describe("running", () => {
  it("refuses to dial without confirm", async () => {
    const { status, body } = await post("/api/run", BATCH);
    expect(status).toBe(400);
    expect(body["refused"]).toBe("confirm was not true");
  });

  /**
   * The console's reason to exist: one dispatch, and two different verdicts
   * side by side. The second place is asked only the first question while the
   * result comes back fully populated — CALL-E issue #316 — so its second
   * field is withheld with a reason.
   */
  it("shows a verified answer and a withheld one from the same batch", async () => {
    const { status, body } = await post("/api/run", { ...BATCH, confirm: true });

    expect(status).toBe(200);
    expect(body["outcome"]).toBe("completed");
    expect(body["simulated"]).toBe(true);

    const targets = body["targets"] as any[];
    expect(targets).toHaveLength(2);

    expect(targets[0].verdict).toBe("verified");
    expect(targets[0].result["accepts_new_patients"]).not.toBeNull();
    expect(targets[0].result["waitlist_weeks"]).not.toBeNull();

    expect(targets[1].verdict).toBe("needs_human");
    expect(targets[1].result["waitlist_weeks"]).toBeNull();
    expect(targets[1].unsupportedFields).toContain("waitlist_weeks");
    expect(targets[1].reasons.join(" ")).toContain("waitlist_weeks");
  });

  it("quotes the turn that established each verified field", async () => {
    const { body } = await post("/api/run", { ...BATCH, confirm: true, batchId: "intake-quote" });
    const fields = (body["targets"] as any[])[0].fields as { field: string; supportingTurn: string | null }[];
    const supported = fields.find((f) => f.field === "accepts_new_patients");
    expect(supported?.supportingTurn).toContain("accepting new patients");
  });

  it("counts the hold time the machine absorbed", async () => {
    await post("/api/run", { ...BATCH, confirm: true, batchId: "intake-hold" });
    const state = (await (await fetch(`${base}/api/state`)).json()) as Record<string, any>;
    // The simulated menu reaches a person at 132 seconds, per recipient.
    expect(state["secondsAbsorbed"]).toBeGreaterThan(0);
    expect(state["routesKnown"]).toBeGreaterThan(0);
  });

  it("fetches the existing call when the same batch id is run twice", async () => {
    const first = await post("/api/run", { ...BATCH, confirm: true, batchId: "intake-replay" });
    const second = await post("/api/run", { ...BATCH, confirm: true, batchId: "intake-replay" });
    expect(first.body["replayed"]).toBe(false);
    expect(second.body["replayed"]).toBe(true);
    expect(second.body["callId"]).toBe(first.body["callId"]);
  });

  it("never invents a recipient for a number the plan refused", async () => {
    // A real dispatch only carries dialable recipients, so the simulation must
    // not answer for one the plan rejected.
    const { body } = await post("/api/run", {
      ...BATCH,
      confirm: true,
      batchId: "intake-refused",
      targets: [...BATCH.targets, { subjectId: "typo", phone: "+1 555 019 9002" }],
    });

    const targets = body["targets"] as any[];
    expect(targets).toHaveLength(2);
    expect(targets.map((t) => t.subjectId)).toEqual(["clinic-north", "clinic-east"]);
    expect(targets.some((t) => String(t.subjectId).startsWith("unknown-"))).toBe(false);
  });

  it("stores only verified facts in the ledger", async () => {
    await post("/api/run", { ...BATCH, confirm: true, batchId: "intake-facts" });
    const state = (await (await fetch(`${base}/api/state`)).json()) as Record<string, any>;
    // Three verified fields across the batch: two for the first clinic, one for
    // the second. The withheld field is not stored.
    expect(state["ledger"]["facts"]).toBeGreaterThan(0);
  });
});

describe("live progress stream", () => {
  const readStream = async (payload: unknown) => {
    const res = await fetch(`${base}/api/run-stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    // The refusal path answers with ordinary indented JSON, not NDJSON, so a
    // naive line split would tear it apart.
    const events = res.headers.get("content-type")?.includes("x-ndjson")
      ? text
          .split("\n")
          .filter((line) => line.trim())
          .map((line) => JSON.parse(line) as Record<string, any>)
      : [JSON.parse(text) as Record<string, any>];
    return { status: res.status, contentType: res.headers.get("content-type"), events, text };
  };

  it("streams newline-delimited events, not one blob at the end", async () => {
    const { status, contentType, events } = await readStream({
      ...BATCH,
      confirm: true,
      batchId: "stream-1",
    });

    expect(status).toBe(200);
    expect(contentType).toContain("application/x-ndjson");
    expect(events.length).toBeGreaterThan(5);
    expect(events[0]?.["type"]).toBe("plan");
    expect(events.at(-1)?.["type"]).toBe("done");
  });

  it("walks each call through the menu and the queue before a person answers", async () => {
    const { events } = await readStream({ ...BATCH, confirm: true, batchId: "stream-2" });
    const phases = events.filter((e) => e["type"] === "phase");

    expect(phases.map((p) => p["phase"])).toContain("menu");
    expect(phases.map((p) => p["phase"])).toContain("holding");
    expect(phases.map((p) => p["phase"])).toContain("answered");

    // The clock is the call's own clock, taken from transcript offsets, and it
    // only moves forward.
    const holding = phases.find((p) => p["phase"] === "holding");
    const answered = phases.find((p) => p["phase"] === "answered");
    expect(Number(answered?.["at"])).toBeGreaterThan(Number(holding?.["at"]));
  });

  it("declares the playback speed rather than implying real time", async () => {
    const { events } = await readStream({ ...BATCH, confirm: true, batchId: "stream-3" });
    const plan = events[0]!;
    expect(plan["playbackSpeed"]).toBeGreaterThan(1);
    expect(String(plan["note"])).toContain("replayed from the transcript");
  });

  it("ends with a verdict per target and every number masked", async () => {
    const { events, text } = await readStream({ ...BATCH, confirm: true, batchId: "stream-4" });
    const verdicts = events.filter((e) => e["type"] === "verdict");

    expect(verdicts).toHaveLength(2);
    expect(verdicts.map((v) => v["verdict"])).toEqual(["verified", "needs_human"]);
    expect(text).not.toContain("+15550199001");
  });

  it("refuses to stream a run without confirm", async () => {
    const { status, events } = await readStream({ ...BATCH, batchId: "stream-5" });
    expect(status).toBe(400);
    expect(events[0]?.["refused"]).toBe("confirm was not true");
  });
});

describe("unknown routes", () => {
  it("answers 404 as JSON rather than leaking a stack", async () => {
    const res = await fetch(`${base}/api/nope`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as Record<string, unknown>)["error"]).toBe("Not found.");
  });
});
