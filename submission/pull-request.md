# Pull request body

Paste this into the PR against `CALLE-AI/awesome-phone-call-agents`.

**Title:** `feat(holdline): add evidence-gated batch enquiry skill`
**Branch:** `feat/holdline-evidence-gated-batch-calls`

Both were checked with the repository's own tooling:

```bash
python3 scripts/check_branch_name.py --branch feat/holdline-evidence-gated-batch-calls
python3 scripts/validate_repository.py
```

---

## Summary

Adds `skills/holdline/`, a skill for asking one question of several places by
phone and returning only the answers the call actually established.

The problem it addresses is recorded in this repository's own tracker. Issue
#316 describes a call whose agent never raised a requested question, and whose
result came back populated anyway — schema-valid, high confidence, and not
supported by anything that was said. A schema check passes that. Nothing in the
response distinguishes *asked and not understood* from *never asked at all*.

This skill checks every returned field against the transcript turns the agent
spoke, and reports six verdicts rather than a boolean:

| Verdict | Meaning |
| --- | --- |
| `verified` | The agent raised the topic and a usable answer came back. |
| `asked_but_unclear` | The agent asked; the answer was not usable. |
| `unattributed` | Some question was asked and answered, but no probe for this field matches it. |
| `attributed` | No probe matched, but one question and one field were left over, so by elimination it can only be this. Off by default. |
| `never_asked` | Nothing was asked that this value could answer. A value present here is flagged. |
| `no_transcript` | No transcript, so nothing could be checked. |

`unattributed` exists because conflating *not confirmed* with *invented* makes
the check unusable in practice. Topic detection is lexical, and an agent
paraphrases constantly; the first version of this accused every paraphrased
question of being fabricated. The skill now counts question-and-answer
exchanges that no probe claims, and only flags a value with no exchange left
to have come from.

That change came out of measurement, not intuition. The implementation ships an
offline evaluation harness over a seeded, labelled corpus of 400 cases:

| | |
| --- | --- |
| Invented values caught | 57/57 — 100% |
| Direct asks passed | 58/58 — 100% |
| Paraphrases wrongly accused of invention | 0/57 — 0% |
| Paraphrases withheld | 57/57 — 100% |
| Prose non-answers caught | 57/57 — 100% |
| Genuine prose answers wrongly withheld | 0/57 — 0% |

The last row is the honest cost and is published deliberately. A paraphrase is
still withheld, because an answer that cannot be attributed to a question
should not be stored as fact. Better probes are the only thing that moves it;
`references/probes.md` explains the trade.

The full engine — parallel dispatch, freshness ledger, route cache, webhook
intake, and the MCP server — lives at https://github.com/Elioz404/HOLDLINE.
This PR is scoped to the skill and its one list entry; the skill is
self-contained and portable, and needs nothing from that repository to run.

## Type

- [x] New skill
- [ ] New runnable app
- [ ] New workflow plugin
- [ ] New provider adapter
- [ ] New scheduler recipe
- [x] README awesome-list entry
- [ ] Safety or documentation update
- [ ] Validation or tooling update

## Checklist

- [x] Repository-facing content is written in English.
- [x] Branch name, commit messages, and PR title follow `docs/git-naming-conventions.md`.
- [x] No secrets, tokens, private phone numbers, call recordings, or private transcripts are included.
- [x] Real-world side effects are clearly described.
- [x] Phone numbers are masked in documentation and test fixtures unless they are clearly fictional.
- [x] Recurring workflows include cancellation behavior.
- [x] Runnable code has a dry-run, fake-server, or no-call path by default.
- [x] `python3 scripts/validate_repository.py` passes.

## Side effects

`run_hold` places outbound calls, billed per call, one per dialable target, as
a single dispatch under one idempotency key derived from `batchId`, `workflow`
and `intent`. Re-running the same three fetches the existing call instead of
dialing again.

`plan_hold` and `get_verdict` never dial. `run_hold` requires `confirm: true`
in the same request and there is no setting that removes the confirmation. The
MCP annotations mark `plan_hold` and `get_verdict` read-only and `run_hold`
destructive, so an agent cannot reach a telephone by accident.

Emergency and crisis prefixes (`+1911`, `+1988`, `+112`, `+999`) are refused
before dialing and no configuration permits them.

## Cancellation

Nothing in this skill schedules recurring work, so there is nothing to cancel.
A batch in flight cannot be recalled; the confirmation before dispatch is the
only stopping point, and this is stated in `SKILL.md`.

An unknown call outcome is never re-dialed. `run_hold` returns
`outcome: "unresolved"` with the call id and a classification, because a
timeout does not mean no call happened — issue #283 records a call that timed
out client-side and then dialed and completed. Reconciliation is the caller's
decision, not an automatic retry.

## Credentials

`CALLE_API_KEY` is read from the environment, used server-side only, and never
written to any output file. Every phone number in every response is masked,
including echoed metadata and error payloads.

## Verification without a call

```bash
HOLDLINE_SIMULATE=1 npm run mcp
```

Runs the tools against a local fake transport. Every response carries
`simulated: true` and a notice that no telephone was involved, so simulated
output cannot be mistaken for a finding.

The engine repository's suite is 161 tests with no network and no credentials,
including tests that drive a real MCP client against the server over an
in-memory transport, and tests that drive the genuine `@call-e/calle`
`CalleClient` against a fake transport implementing the documented wire
contract.

## Note on live calls

Seven live calls, across six dispatches, were placed on 2026-09-07 to
published automated customer-service lines, and they are worth reporting because of what they broke
rather than what they proved.

They confirmed CALL-E reaches and transcribes real phone trees, and that an
agent can state a purpose and have an IVR confirm and route it. They also
disproved two things this project had written down as true: that CALL-E labels
system audio `unknown` (it does not — the automated system came back as `user`,
which made a hold metric meaningless), and that the probe's traversal check
meant anything (it matched the word "press" in a recording's own greeting).
Both are fixed.

Three of those calls are kept whole and masked in `fixtures/`, and the engine
repository's `test/saved-call.test.ts` runs the gate over every one. Between
them they cover the whole range of what the gate says about real speech:

| Real call | The API reported | The gate returned |
| --- | --- | --- |
| 37 turns; the agent states a purpose, the IVR confirms and routes it | `taskCompleted: true`, 0.9 | `department_confirmed` **verified**, quoting a turn genuinely spoken |
| two carriers, one dispatch, both calls ~6 seconds, **zero** transcript turns | `taskCompleted: true` at confidence **1.0**, with every field of `structuredResult` returned as `"unknown"` | every field `no_transcript`, **everything withheld** |
| 194 seconds, 23 turns; the agent asks and keeps asking, the system never answers and demands the keypad | `taskCompleted: true`, 0.88 | `asked_but_unclear`, **withheld** |

The middle row is worth stating precisely, because the obvious complaint is not
the right one. The telephony counters were correct — the summary reads
"[dispatch summary]", and both calls did
connect and complete. The narrow, reproducible problem is that `taskCompleted`
came back `true` at confidence 1.0 on a dispatch whose own `structuredResult`
was `{"saturday_delivery": "unknown", "costs_extra": "unknown"}` for both
recipients. The model said it did not know and the flag said it was done.

Our own share of that is recorded alongside it: the task text ended with "if a
person answers, thank them and end the call", and since CALL-E labels the
automated system as a person, the greeting almost certainly fired our own exit
instruction. Removing the clause produced the 194-second call in the third row,
so the six-second hangups were our bug. That does not account for the
completion flag, and a caller branching on it would have stored two answers
nobody gave.

The first row also carries the honest cost. `reached_human: "no"` was
**correct** — nobody human came on the line — and the gate withheld it anyway,
because nothing was *asked* that the value answers; the truth sat in what did
not happen. This design cannot credit a fact established by absence. That is a
boundary of the approach rather than a defect to be tuned away, it is
documented as one in `references/safety.md`, and a test pins it so the claim
cannot quietly stop being true.

**The keypad boundary is now observed rather than assumed.** On the last call
the carrier system stopped accepting speech and demanded DTMF — "please key in
the number of the option you'd like" — and the call ended without one. This
skill does not press keys. That is a limit, it was watched happening, and it is
not written up as a feature.

Everything else in this submission — the evaluation corpus, the console
scenarios, the fake transport — is synthetic and labelled as such. No figure
here is a measurement of CALL-E's live performance.
