# HOLDLINE

An evidence-gated engine for phone calls that have to get through a queue before
they get an answer.

Built on [CALL-E](https://docs.heycall-e.com/). Status: **day 1 of 8**, core
modules only. See [Status](#status) for exactly what exists and what does not —
nothing below describes unwritten code.

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
| Evidence Gate | `src/evidence/gate.ts` | Judges each result field against the bot's spoken turns. Four verdicts: `verified`, `asked_but_unclear`, `never_asked`, `no_transcript`. |
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

**Limits of the check, stated plainly.** Topic detection is lexical: a probe is
a list of substrings and regular expressions matched case-insensitively against
bot turns. It will miss a paraphrase sharing no vocabulary with its probes, and
it will fire on a bot turn that mentions a topic without asking about it. It is
a floor — it catches fields the call never went near — not a proof that a
question was well asked. Probe quality is the operator's job.
`test/evidence-gate.test.ts` pins the failure modes, including the one where a
caller volunteers information and the gate correctly refuses to credit it as
the agent having asked.

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

## Running it

```bash
npm install
npm test          # 40 tests, no network, no credentials
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

Day 1 of 8. What is listed under [What exists today](#what-exists-today) is
written, typechecked, and covered by the test suite. **Not yet built:** the
parallel queue engine, the freshness ledger, the IVR route cache, the MCP
server, the Agent Skill packaging, the Slack plugin, and the web console. They
are planned, not present.

No live call has been placed yet, so no claim is made here about how CALL-E
behaves against a real phone menu. `fixtures/traversal-with-menu.json` is
synthetic and labelled as such; it exercises the replay path and nothing more.
That question is what the probe exists to answer.

## License

MIT.
