/**
 * A fake CALL-E transport.
 *
 * This is not a stub that returns a canned object. It is a `fetch`
 * implementation matching the real wire contract — `POST /v1/calls`,
 * `GET /v1/calls/{id}`, `GET /v1/calls/{id}/events`, snake_case bodies, the
 * `Idempotency-Key` header — so it can be handed to the genuine `CalleClient`
 * via its `fetch` option. The engine under test talks to the real SDK; only
 * the network is replaced.
 *
 * That matters for two reasons. Development and CI need no credentials and
 * place no calls. And when credentials arrive, nothing above this line
 * changes: the fake is swapped out and the same code path runs for real.
 *
 * It also deliberately reproduces CALL-E's *documented failure modes*, so the
 * engine is written against the platform as it actually behaves rather than as
 * the happy path implies:
 *
 *   - `idempotent_replay`  reusing a key returns 201 with the existing call,
 *                          indistinguishable from a new one (issue #315)
 *   - `late_dial`          the call stays queued past a client's patience and
 *                          completes afterwards (issue #283)
 *   - `stuck_in_progress`  never reaches a terminal state (issue #305)
 *   - `slow_first_speech`  long silence before the bot speaks (issue #295)
 *   - `never_asked`        a populated result for a question the bot skipped
 *                          (issue #316) — the case the Evidence Gate exists for
 *
 * Phone numbers in every scenario are in the +1555 reserved-for-fiction range.
 */

import type { CallTranscriptTurn } from "../evidence/types.js";

export type WireCallStatus = "queued" | "in_progress" | "completed" | "failed" | "canceled";
export type WireAttemptStatus = "queued" | "dialing" | "in_progress" | "completed" | "failed" | "canceled";
export type WireRecipientStatus = "pending" | "in_progress" | "completed" | "failed" | "skipped";

export interface ScenarioRecipient {
  readonly phone: string;
  readonly transcript: readonly CallTranscriptTurn[];
  readonly structuredResult?: Record<string, unknown> | null;
  readonly finalStatus?: WireRecipientStatus;
}

export interface Scenario {
  /** Polls (after create) before the task reaches a terminal state. */
  readonly pollsUntilTerminal: number;
  readonly finalStatus: WireCallStatus;
  readonly recipients: readonly ScenarioRecipient[];
  readonly structuredResult?: Record<string, unknown> | null;
  readonly completionConfidence?: { score: number; label: string } | null;
  readonly evidence?: readonly string[];
  readonly taskCompleted?: boolean | null;
  /** When set, `POST /v1/calls` fails with this instead of creating a call. */
  readonly createError?: { status: number; code: string; message: string };
}

const turn = (
  speaker: CallTranscriptTurn["speaker"],
  text: string,
  offset: number | null = null,
): CallTranscriptTurn => ({ offset_seconds: offset, speaker, text });

/** A three-level phone menu ending in a queue and then a person. */
const IVR_TRANSCRIPT: CallTranscriptTurn[] = [
  turn("unknown", "Thank you for calling. Please listen carefully as our menu options have changed.", 3),
  turn("unknown", "For billing press 1. For account services press 2.", 10),
  turn("bot", "Selecting account services.", 17),
  turn("unknown", "For new accounts press 2. For existing customers press 1.", 22),
  turn("bot", "Selecting existing customers.", 29),
  turn("unknown", "All of our representatives are currently busy. Please hold.", 34),
  turn("user", "Account services, this is Dana.", 208),
  turn("bot", "Hello, I am an automated assistant. Am I through to the account services department?", 212),
  turn("user", "Yes, you are.", 219),
  turn("bot", "Thank you. Can you confirm the current status of reference 88431?", 223),
  turn("user", "That one is still in review.", 230),
];

export const SCENARIOS = {
  /** Menu navigated, queue held, human reached, question asked and answered. */
  ivr_traversal: {
    pollsUntilTerminal: 2,
    finalStatus: "completed",
    taskCompleted: true,
    completionConfidence: { score: 0.88, label: "high" },
    evidence: ["The representative confirmed the department.", "The status was stated as in review."],
    structuredResult: { reached_department: "yes", reference_status: "in_review" },
    recipients: [
      {
        phone: "+15550199001",
        transcript: IVR_TRANSCRIPT,
        structuredResult: { reached_department: "yes", reference_status: "in_review" },
      },
    ],
  },

  /**
   * Issue #316. The bot confirmed the department and then hung up without ever
   * raising the reference number, yet a confident status came back anyway.
   */
  never_asked: {
    pollsUntilTerminal: 2,
    finalStatus: "completed",
    taskCompleted: true,
    completionConfidence: { score: 0.91, label: "high" },
    evidence: ["The representative confirmed the department."],
    structuredResult: { reached_department: "yes", reference_status: "in_review" },
    recipients: [
      {
        phone: "+15550199002",
        structuredResult: { reached_department: "yes", reference_status: "in_review" },
        transcript: [
          turn("user", "Account services, this is Dana.", 12),
          turn("bot", "Hello, I am an automated assistant. Am I through to the account services department?", 15),
          turn("user", "Yes.", 20),
          turn("bot", "Thank you for your time. Goodbye.", 23),
        ],
      },
    ],
  },

  /** Issue #295: a long silence before the bot says anything. */
  slow_first_speech: {
    pollsUntilTerminal: 2,
    finalStatus: "completed",
    taskCompleted: true,
    completionConfidence: { score: 0.72, label: "medium" },
    structuredResult: { reached_department: "yes" },
    recipients: [
      {
        phone: "+15550199003",
        structuredResult: { reached_department: "yes" },
        transcript: [
          turn("user", "Hello? Hello?", 4),
          turn("bot", "Hello, I am an automated assistant. Am I through to the right department?", 23),
          turn("user", "Yes, barely. You were silent for a while.", 29),
        ],
      },
    ],
  },

  /** Nobody picked up; voicemail answered. No transcript evidence of an ask. */
  voicemail: {
    pollsUntilTerminal: 2,
    finalStatus: "completed",
    taskCompleted: false,
    completionConfidence: { score: 0.2, label: "low" },
    structuredResult: null,
    recipients: [
      {
        phone: "+15550199004",
        structuredResult: null,
        transcript: [
          turn("unknown", "Please leave a message after the tone.", 18),
          turn("bot", "No message left.", 21),
        ],
      },
    ],
  },

  /** Issue #283: still queued long past a client's patience, completes later. */
  late_dial: {
    pollsUntilTerminal: 25,
    finalStatus: "completed",
    taskCompleted: true,
    completionConfidence: { score: 0.8, label: "high" },
    structuredResult: { reached_department: "yes" },
    recipients: [
      {
        phone: "+15550199005",
        transcript: IVR_TRANSCRIPT,
        structuredResult: { reached_department: "yes", reference_status: "in_review" },
      },
    ],
  },

  /** Issue #305: accepted, then never reaches a terminal state. */
  stuck_in_progress: {
    pollsUntilTerminal: Number.POSITIVE_INFINITY,
    finalStatus: "in_progress",
    recipients: [{ phone: "+15550199006", transcript: [] }],
  },

  /** Planner quota exhausted, reported as a bare 503. */
  provider_unavailable: {
    pollsUntilTerminal: 0,
    finalStatus: "failed",
    recipients: [],
    createError: {
      status: 503,
      code: "provider_unavailable",
      message: "Call planning is temporarily unavailable.",
    },
  },
} satisfies Record<string, Scenario>;

export type ScenarioName = keyof typeof SCENARIOS;

interface StoredCall {
  id: string;
  task: string;
  metadata: Record<string, unknown>;
  scenario: Scenario;
  polls: number;
  createdAt: string;
}

export interface FakeCalleOptions {
  /** Scenario applied to every created call unless `scenarioFor` overrides it. */
  readonly scenario?: Scenario;
  /** Choose a scenario from the task text, e.g. for multi-recipient tests. */
  readonly scenarioFor?: (task: string) => Scenario;
}

export interface FakeCalle {
  /** Hand this to `new CalleClient({ apiKey, fetch })`. */
  readonly fetch: (input: Request) => Promise<Response>;
  /** Every idempotency key seen, in order, including replays. */
  readonly idempotencyKeysSeen: readonly string[];
  /** Number of distinct calls actually created. */
  readonly createdCount: number;
  /** Force a stored call to its terminal state, for reconciliation tests. */
  settle(callId: string): void;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

export function createFakeCalle(options: FakeCalleOptions = {}): FakeCalle {
  const calls = new Map<string, StoredCall>();
  const byIdempotencyKey = new Map<string, string>();
  const keysSeen: string[] = [];
  let seq = 0;

  const pickScenario = (task: string): Scenario =>
    options.scenarioFor?.(task) ?? options.scenario ?? SCENARIOS.ivr_traversal;

  function render(stored: StoredCall): unknown {
    const { scenario } = stored;
    const terminal = stored.polls >= scenario.pollsUntilTerminal;
    const status: WireCallStatus = terminal ? scenario.finalStatus : stored.polls === 0 ? "queued" : "in_progress";
    const done = terminal && scenario.finalStatus === "completed";

    return {
      id: stored.id,
      object: "call_task",
      status,
      task: stored.task,
      structured_result: done ? (scenario.structuredResult ?? null) : null,
      summary: done ? "Fake scenario completed." : null,
      task_completed: done ? (scenario.taskCompleted ?? null) : null,
      completion_confidence: done ? (scenario.completionConfidence ?? null) : null,
      evidence: done ? (scenario.evidence ?? []) : [],
      metadata: stored.metadata,
      failure_code: null,
      failure_message: null,
      created_at: stored.createdAt,
      completed_at: done ? new Date().toISOString() : null,
      recipients: scenario.recipients.map((recipient, index) => ({
        id: `rcp_fake_${index + 1}`,
        phones: [recipient.phone],
        locale: "en-US",
        region: "US",
        status: (done
          ? (recipient.finalStatus ?? "completed")
          : stored.polls === 0
            ? "pending"
            : "in_progress") satisfies WireRecipientStatus,
        structured_result: done ? (recipient.structuredResult ?? null) : null,
        summary: null,
        attempts: [
          {
            id: `att_fake_${index + 1}`,
            phone: recipient.phone,
            status: (done ? "completed" : "in_progress") satisfies WireAttemptStatus,
            started_at: stored.createdAt,
            completed_at: done ? new Date().toISOString() : null,
            summary: null,
            provider_call_id: `prov_fake_${index + 1}`,
            failure_code: null,
            failure_message: null,
            transcript_turns: done ? recipient.transcript : [],
          },
        ],
      })),
    };
  }

  const fake: FakeCalle = {
    idempotencyKeysSeen: keysSeen,
    get createdCount() {
      return calls.size;
    },
    settle(callId: string) {
      const stored = calls.get(callId);
      if (stored) stored.polls = Number.MAX_SAFE_INTEGER;
    },
    async fetch(input: Request): Promise<Response> {
      const url = new URL(input.url);
      const { pathname } = url;

      if (input.method === "POST" && pathname === "/v1/calls") {
        const body = (await input.json()) as { task?: string; metadata?: Record<string, unknown> };
        const task = body.task ?? "";
        const key = input.headers.get("Idempotency-Key");
        if (key) keysSeen.push(key);

        // Issue #315: a replayed key answers 201 Created with the existing
        // call. From the client's side this is indistinguishable from a new
        // dispatch, which is exactly why the engine keeps its own ledger.
        if (key && byIdempotencyKey.has(key)) {
          const existing = calls.get(byIdempotencyKey.get(key)!)!;
          return json(render(existing), 201);
        }

        const scenario = pickScenario(task);
        if (scenario.createError) {
          const { status, code, message } = scenario.createError;
          return json({ error: { code, message, details: {} } }, status);
        }

        seq += 1;
        const stored: StoredCall = {
          id: `call_fake_${seq}`,
          task,
          metadata: body.metadata ?? {},
          scenario,
          polls: 0,
          createdAt: new Date().toISOString(),
        };
        calls.set(stored.id, stored);
        if (key) byIdempotencyKey.set(key, stored.id);
        return json(render(stored), 201);
      }

      const match = /^\/v1\/calls\/([^/]+)$/.exec(pathname);
      if (input.method === "GET" && match) {
        const stored = calls.get(match[1]!);
        if (!stored) return json({ error: { code: "not_found", message: "No such call." } }, 404);
        stored.polls += 1;
        return json(render(stored));
      }

      if (input.method === "GET" && /^\/v1\/calls\/[^/]+\/events$/.test(pathname)) {
        return json({ object: "list", data: [], next_cursor: null });
      }

      return json({ error: { code: "not_found", message: `Unhandled ${input.method} ${pathname}` } }, 404);
    },
  };

  return fake;
}
