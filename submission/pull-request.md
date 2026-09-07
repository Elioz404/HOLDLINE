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
| Invented values caught | 80/80 — 100% |
| Direct asks passed | 80/80 — 100% |
| Paraphrases wrongly accused of invention | 0/80 — 0% |
| Paraphrases withheld | 80/80 — 100% |

The last row is the honest cost and is published deliberately. A paraphrase is
still withheld, because an answer that cannot be attributed to a question
should not be stored as fact. Better probes are the only thing that moves it;
`references/probes.md` explains the trade.

The full engine — parallel dispatch, freshness ledger, route cache, webhook
intake, and the MCP server — lives at
https://github.com/Elioz404/HOLDLINE and is listed as an app entry. The skill
here is self-contained and portable.

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

The engine repository's suite is 151 tests with no network and no credentials,
including tests that drive a real MCP client against the server over an
in-memory transport, and tests that drive the genuine `@call-e/calle`
`CalleClient` against a fake transport implementing the documented wire
contract.

## Note on live calls

Three live calls were placed on 2026-09-07 to published automated
customer-service lines, and they are worth mentioning because of what they
broke rather than what they proved.

They confirmed CALL-E reaches and transcribes real phone trees, and that an
agent can state a purpose and have an IVR confirm and route it. They also
disproved two things this project had written down as true: that CALL-E labels
system audio `unknown` (it does not — the automated system came back as `user`,
which made a hold metric meaningless), and that the probe's traversal check
meant anything (it matched the word "press" in a recording's own greeting).
Both are fixed.

One call is kept whole, masked, as `fixtures/saved-call-fedex-tracking.json`,
and `test/saved-call.test.ts` runs the gate over it. The result is not a
gotcha, and is more useful than one:

- CALL-E's own summary of the call is candid — it says the system would not
  continue without a tracking number, which is exactly what happened.
- Alongside it, `taskCompleted` is `true` at 0.9 confidence.
- The gate verifies `department_confirmed` and quotes the turn that
  established it, a line genuinely spoken on the call.
- It withholds `reached_human: "no"`, which was **correct**. Nobody human came
  on the line. Nothing was asked that the value answers; the truth sits in what
  did not happen, and this design cannot credit that.

That last point is a real boundary of the approach, not a defect to be tuned
away, and it is documented as one in `references/safety.md` and pinned by a
test so the claim cannot quietly stop being true. Withholding a correct answer
is the cost of never storing an unsupported one.

Keypad traversal is still unobserved: the systems reached accepted speech and
the agent used it.

Everything else in this submission — the evaluation corpus, the console
scenarios, the fake transport — is synthetic and labelled as such. No figure
here is a measurement of CALL-E's live performance.
