import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { CalleClient } from "@call-e/calle";

import { redact, redactError } from "../src/core/redact.js";
import { runQueue } from "../src/engine/queue.js";
import { SCENARIOS, createFakeCalle } from "../src/testing/fake-calle.js";
import type { FieldProbe } from "../src/evidence/types.js";

/**
 * Cross-cutting invariants, enforced rather than documented.
 *
 * A checklist in a README rots. These fail the build.
 */

const ROOT = join(import.meta.dirname, "..");
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "probe-output", ".vscode"]);
const TEXT_EXT = new Set([".ts", ".js", ".mjs", ".json", ".md", ".html", ".yml", ".yaml"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (TEXT_EXT.has(entry.slice(entry.lastIndexOf(".")))) out.push(full);
  }
  return out;
}

const FILES = walk(ROOT).filter((f) => !relative(ROOT, f).startsWith("package-lock.json"));

/** E.164 numbers anywhere in a file. */
const E164 = /\+[1-9]\d{7,14}/g;

/**
 * Ranges reserved for fiction. North American `555-01xx` is the documented
 * fictional block; `+1911`, `+1988`, `+112` and `+999` appear only as blocked
 * prefixes in tests.
 */
const FICTIONAL = [
  /^\+1\d{3}555\d{4}$/, // +1 NPA 555 xxxx
  /^\+1555\d{7}$/,
  /^\+19110000000$/,
  /^\+19889999999$/,
  /^\+112\d*$/,
  /^\+999\d*$/,
  /^\+12345678$/, // length-boundary fixtures
  /^\+123456789012345$/,
  /^\+1234567890123456$/,
  /^\+1234567$/,
  /^\+442079460958$/, // Companies House switchboard, published, used once in a redaction test
  // The placeholder blocklist in src/core/phone.ts — numbers the engine
  // explicitly refuses to dial. They have to appear in order to be refused.
  /^\+10000000000$/,
  /^\+11111111111$/,
  /^\+12345678901$/,
  // An impossible Argentine number, used to pin that +54 is not a callable
  // region. It is all fives so it cannot belong to anyone.
  /^\+545555555555$/,
  // Region-matching fixtures in test/regions.test.ts. Listed one by one rather
  // than loosening the rule to "anything containing 555": outside North America
  // that prefix is not reserved, and a broad rule here would let a real number
  // through the one check meant to stop it.
  /^\+525555550199$/, // Mexico
  /^\+34555550199$/, // Spain
  /^\+50455501990$/, // Honduras
];

describe("no real phone numbers in the repository", () => {
  it("every E.164 literal sits in a reserved or fictional range", () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      const text = readFileSync(file, "utf8");
      for (const match of text.match(E164) ?? []) {
        if (!FICTIONAL.some((pattern) => pattern.test(match))) {
          offenders.push(`${relative(ROOT, file)}: ${match}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("no secrets in the repository", () => {
  it("contains no live-looking API key outside the redaction tests", () => {
    // Real keys are `iams_live_...`. Two tests use an obvious decoy of that
    // shape to prove redaction strips it, so `test/` is excluded here — a key
    // has no business in shipped code, docs, or configuration regardless.
    const offenders: string[] = [];
    for (const file of FILES) {
      if (relative(ROOT, file).startsWith("test")) continue;
      const text = readFileSync(file, "utf8");
      for (const match of text.match(/iams_live_[A-Za-z0-9_-]+/g) ?? []) {
        offenders.push(`${relative(ROOT, file)}: ${match.slice(0, 14)}…`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the .env example empty of any value", () => {
    // A filled-in example is how a key reaches a public repository.
    const example = readFileSync(join(ROOT, ".env.example"), "utf8");
    for (const line of example.split("\n")) {
      const [, value] = line.split("=");
      if (line.startsWith("#") || !line.includes("=")) continue;
      if (line.startsWith("HOLDLINE_PROBE_LABEL")) continue; // a harmless label
      expect(value?.trim() ?? "").toBe("");
    }
  });

  it("gitignores the files that would carry one", () => {
    const ignored = readFileSync(join(ROOT, ".gitignore"), "utf8");
    // `.env` holds the key; `probe-output/` holds unmasked transcripts of real
    // conversations. Both must stay untracked.
    expect(ignored).toMatch(/^\.env$/m);
    expect(ignored).toMatch(/^probe-output\/$/m);
  });
});

describe("the README does not promise images it lacks", () => {
  it("every screenshot the README shows actually exists and has content", () => {
    // A broken image in a README is worse than no image: it says the project
    // is unmaintained before a reader has read a line. Timestamps would be the
    // stricter check, but git does not preserve them across a clone, so this
    // asserts what survives: the file is there and is not empty.
    const readme = readFileSync(join(ROOT, "README.md"), "utf8");
    const referenced = Array.from(readme.matchAll(/docs\/screenshots\/[a-z0-9-]+\.png/g)).map(
      (match) => match[0],
    );

    expect(referenced.length, "README should illustrate the console").toBeGreaterThan(0);
    for (const image of new Set(referenced)) {
      const bytes = readFileSync(join(ROOT, image)).length;
      expect(bytes, `${image} should exist and have content`).toBeGreaterThan(1000);
    }
  });

  it("the capture tools still point at selectors the page has", () => {
    // If the console is restructured and these ids disappear, the gallery and
    // the recorder would frame the wrong thing silently — a caption over a
    // screen that does not show what it describes. This catches it before
    // anyone runs them.
    const page = readFileSync(join(ROOT, "src/console/index.html"), "utf8");
    for (const tool of ["src/tools/gallery.ts", "src/tools/video.ts"]) {
      const source = readFileSync(join(ROOT, tool), "utf8");
      for (const id of ["planout", "board", "cards", "summary"]) {
        expect(source, `${tool} should reference #${id}`).toContain(id);
        expect(page, `page should still define #${id}`).toContain(id);
      }
    }
  });
});

describe("redaction holds at every boundary", () => {
  const probes: FieldProbe[] = [
    { field: "reached_department", required: true, asks: ["department", "through to"] },
  ];

  it("the engine's own output carries no raw number", async () => {
    const fake = createFakeCalle({ scenario: SCENARIOS.ivr_traversal });
    const client = new CalleClient({ apiKey: "iams_test_key", fetch: fake.fetch });

    const outcome = await runQueue(
      {
        workflow: "audit",
        intent: "check",
        batchId: "audit-1",
        goal: "Confirm the department.",
        targets: [{ subjectId: "vendor", phone: "+15550199001" }],
        probes,
        recipientResultSchema: { type: "object" },
        mode: "live",
      },
      { client, intervalMs: 1, timeoutMs: 5000 },
    );

    expect(outcome.kind).toBe("completed");
    if (outcome.kind !== "completed") return;

    // The transcript is carried deliberately and is the caller's to redact.
    // Everything the engine formats for a human must already be masked.
    for (const target of outcome.targets) {
      expect(target.maskedPhone).not.toContain("15550199001");
      expect(JSON.stringify(target.gate)).not.toContain("+15550199001");
    }
  });

  it("redacts a provider error that quotes the request back", () => {
    const error = Object.assign(new Error("call to +15550199001 failed"), {
      code: "internal_error",
      status: 500,
      details: { request: { recipients: [{ phone: "+15550199001" }] }, apiKey: "iams_live_secret" },
    });
    const rendered = JSON.stringify(redactError(error));

    expect(rendered).not.toContain("15550199001");
    expect(rendered).not.toContain("iams_live_secret");
    expect(rendered).toContain("[redacted]");
  });

  it("redacts an unknown shape rather than passing it through", () => {
    const rendered = JSON.stringify(
      redact({ nested: [{ deep: { phone: "+15550199001", token: "abc" } }] }),
    );
    expect(rendered).not.toContain("15550199001");
    expect(rendered).toContain('"token":"[redacted]"');
  });
});

describe("dialing is never the default", () => {
  it("the queue previews unless explicitly told to dial", async () => {
    const fake = createFakeCalle({ scenario: SCENARIOS.ivr_traversal });
    const client = new CalleClient({ apiKey: "iams_test_key", fetch: fake.fetch });

    const outcome = await runQueue(
      {
        workflow: "audit",
        intent: "check",
        batchId: "audit-2",
        goal: "Confirm the department.",
        targets: [{ subjectId: "vendor", phone: "+15550199001" }],
        probes: [{ field: "x", required: true, asks: ["x"] }],
        recipientResultSchema: { type: "object" },
        // mode omitted on purpose
      },
      { client },
    );

    expect(outcome.kind).toBe("preview");
    expect(fake.createdCount).toBe(0);
  });
});
