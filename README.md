# HOLDLINE

An evidence-gated engine for phone calls that have to get through a queue before
they get an answer.

Built on [CALL-E](https://docs.heycall-e.com/). Status: **day 3 of 8**, engine,
core modules, and a measured gate. See [Status](#status) for exactly what exists and what does
not — nothing below describes unwritten code.

## Why

A call result tells you what the model concluded. It does not tell you what was
said out loud.

CALL-E issue [#316](https://github.com/CALLE-AI/awesome-phone-call-agents/issues/316)
records the gap precisely: a participant asked for an address confirmation, the
agent never raised the question during the call, and the result still came back
populated with `address_correct: "unclear"`. The value was schema-valid and the
confidence was high. Nothing in the response distinguished *asked and not
understood* from *never asked at all*.

Every field HOLDLINE returns is checked against the transcript turns the agent
actually spoke. A field whose topic no bot turn raised does not come back, no
matter how confident the model sounded.

## What exists today

| Module | File | What it does |
| --- | --- | --- |
| Queue engine | `src/engine/queue.ts` | Asks one question of many places in a single dispatch, then gates each answer separately. Preview by default. |
| Evidence Gate | `src/evidence/gate.ts` | Judges each result field against the bot's spoken turns. Four verdicts: `verified`, `asked_but_unclear`, `never_asked`, `no_transcript`. |
| Fake transport | `src/testing/fake-calle.ts` | A `fetch` implementation of the CALL-E wire contract that reproduces the platform's documented failure modes. |
| Evaluation harness | `src/eval/` | Measures the gate against a seeded, labelled corpus — including cases it is expected to get wrong. |
| Task compiler | `src/core/task-compiler.ts` | Fits a task into the API's 255-character `task` limit by dropping declared-low-priority segments, and fails rather than truncating a required one. |
| Failure classifier | `src/core/outcome.ts` | Sorts failures into `retryable`, `deterministic`, and `reconcile`. |
| Idempotency | `src/core/idempotency.ts` | Derives keys from the authorizing business record. Records issued keys so a replay is distinguishable from a fresh dispatch. |
| Phone handling | `src/core/phone.ts` | Strict E.164 validation, placeholder and emergency-line refusal, masking. |
| Output redaction | `src/core/redact.ts` | Masks phone numbers and strips secrets from every outgoing value, including echoed metadata and error payloads. |
| Traversal probe | `src/probe/validate-traversal.ts` | Places one real call to find out whether CALL-E gets through a phone menu, and writes the run down. |

### The Evidence Gate

```ts
const report = runEvidenceGate({
  structuredResult: call.structuredResult,
  transcriptTurns: turns,
  probes: [{ field: "address_correct", required: true, asks: ["address", "mailing"] }],
  completionConfidence: call.completionConfidence,
});

report.verdict;           // "verified" | "needs_human"
report.unsupportedFields; // fields carrying a value the call never asked about
gatedResult(report, call.structuredResult); // unverified fields forced to null
```

The overall verdict is `verified` only when every required field is `verified`
**and** completion confidence clears a floor (default `0.7`). There is no
partial pass.

#### Not confirmed is not the same as invented

A fifth verdict, `unattributed`, exists because conflating those two makes the
gate useless. If the bot asked a real question and got a real answer, but
phrased it in words no probe contains, the field is withheld — and it is *not*
reported as invented. The gate counts question-and-answer exchanges no probe
claims; only a value with no unclaimed exchange left to have come from is
flagged. That distinction was added because the harness measured its absence.

### What it measures

```
npm run eval
```

400 seeded cases, offline, no calls placed:

| | |
| --- | --- |
| Invented values caught | **80/80 — 100%** |
| Direct asks passed | 80/80 — 100% |
| Paraphrases wrongly accused | **0/80 — 0%** |
| Paraphrases withheld | 80/80 — 100% |

The last row is the honest cost and it is reported deliberately. Topic
detection is lexical: a probe is a list of substrings and regular expressions
matched case-insensitively against bot turns, so a question sharing no
vocabulary with its probes reads as unattributable and is withheld. The gate
fails toward withholding. Better probes reduce this; the number is published so
the trade is visible rather than omitted.

These figures come from a synthetic corpus that the gate is measured against,
not from live calls. `src/eval/corpus.ts` generates it deterministically from a
seed, and it deliberately contains cases the gate is expected to fail.

### Why `reconcile` is a separate failure class

Issue [#283](https://github.com/CALLE-AI/awesome-phone-call-agents/issues/283)
documents a call that sat queued for 49 minutes, raised `CalleTimeoutError` in
the SDK's `waitForResult`, then dialed anyway and completed. A timeout does not
mean no call happened, so retrying one places a second real call to a real
person. Timeouts, dropped connections, and unrecognized 5xx responses are
classified `reconcile`: go find out what happened before doing anything else.

### Masking, exactly

`maskPhone` keeps the leading `+`, the first two digits, and the last two.
`+14155550199` becomes `+14••••99`. The bullet run is fixed width, so the mask
does not encode the original length. It does not preserve the country code — a
country code is one to three digits and this keeps two. A string that is not
valid E.164 is replaced with `[redacted-phone]` rather than passed through.

### Developing without credentials

`src/testing/fake-calle.ts` is not a stub. It implements the CALL-E wire
contract — `POST /v1/calls`, `GET /v1/calls/{id}`, snake_case bodies, the
`Idempotency-Key` header — as a `fetch` function, and is handed to the genuine
`CalleClient` through its `fetch` option. The engine talks to the real SDK;
only the network is replaced. When credentials arrive, the fake is removed and
the same code path runs for real.

It reproduces the platform's documented failure modes so the engine is written
against CALL-E as it behaves rather than as the happy path implies:

| Scenario | Reproduces |
| --- | --- |
| `ivr_traversal` | A three-level menu, a hold queue, then a person. |
| `never_asked` | A confident, schema-valid result for a question the bot skipped ([#316](https://github.com/CALLE-AI/awesome-phone-call-agents/issues/316)). |
| `late_dial` | Still queued past the client's patience, dials afterwards ([#283](https://github.com/CALLE-AI/awesome-phone-call-agents/issues/283)). |
| `stuck_in_progress` | Accepted, never reaches a terminal state ([#305](https://github.com/CALLE-AI/awesome-phone-call-agents/issues/305)). |
| `slow_first_speech` | Long silence before the bot speaks ([#295](https://github.com/CALLE-AI/awesome-phone-call-agents/issues/295)). |
| `provider_unavailable` | A bare 503 from call creation. |

Replaying a used idempotency key returns `201 Created` with the existing call,
exactly as the real API does — which is why the engine keeps its own ledger
instead of reading a 201 as "a phone rang".

## Running it

```bash
npm install
npm test          # 70 tests, no network, no credentials
npm run eval      # measures the gate against a seeded corpus
npm run typecheck
```

The traversal probe is dry by default:

```bash
npm run probe                                          # compiles the task, dials nothing
npm run probe -- --fixture fixtures/traversal-with-menu.json   # replays a saved run
npm run probe -- --live --to '+1...'                   # places ONE real call
```

Live mode requires the `--live` flag **and** typing `LIVE` at the prompt. There
is no flag that skips the prompt.

### Side effects

Only `--live` places a call, and only one, to the single number given. Nothing
in this repository schedules recurring work, so there is nothing to cancel. The
probe writes two files under `probe-output/`: a `.raw.json` containing an
unmasked transcript of a real conversation, and a `.masked.json` safe to share.
`probe-output/` is gitignored and must stay that way.

### Credentials

`CALLE_API_KEY` is read from the environment, used server-side only, and never
written to any output file. See `.env.example`.

## Status

Day 3 of 8. What is listed under [What exists today](#what-exists-today) is
written, typechecked, and covered by the test suite. **Not yet built:** the
webhook receiver, the freshness ledger, the IVR route cache, the MCP server,
the Agent Skill packaging, the Slack plugin, and the web console. They are
planned, not present.

**No live call has been placed.** Every scenario in the fake transport and
`fixtures/traversal-with-menu.json` is synthetic and labelled as such. They
model behaviour reported in CALL-E's public issue tracker; they are not
observations of this project's own calls, and nothing here should be read as a
measurement of how CALL-E performs against a real phone menu. That question is
what `src/probe/validate-traversal.ts` exists to answer, and it is unanswered.

## License

MIT.
