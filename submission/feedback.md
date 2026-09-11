# Most Valuable Feedback

Five prizes of $200, a separate category that does not compete with the main
one, and — going by the repository's issue tracker — barely contested.

Everything below came out of building against CALL-E for a week. Each item is
written the way the maintainers' own triaged issues are written: what happened,
what the evidence is, why it matters, and what would fix it. No "+1", no
speculation.

**Where this goes — read this before splitting anything up.**

The prize requires the **CALL-E Feedback Survey**, not a Discord message:
https://call-e.devpost.com/details/feedback

Three rules from the official rules page that shape how to use this document:

- **One feedback submission per entrant.** Everything below goes into that
  single submission. Do not file them separately.
- The feedback period runs to **18 September 2026** — four days after the
  project deadline. Do the project first.
- Submitting feedback does not cost you a project prize. The rule that sounds
  alarming — *"individuals who only submit Most Valuable Feedback Surveys will
  NOT be eligible for any additional prizes"* — excludes people who submit
  **only** feedback and no project. Doing both is fine.

The survey asks for feedback that is *"complete with actionable comments that
the Sponsor can use to improve CALL-E or related documentation."* That is what
this document is written to be.

Every item below is written from something that happened while building, and
item 1 is written up as *resolved* rather than as an open complaint — the
account came through on 2026-09-07. The survey asks for feedback the sponsor can
act on, and a fault that has already been diagnosed and closed is easier to act
on than one still being argued about.

---

## 1. There is no self-serve sign-up path, and the docs imply there is

**Status: resolved for us on 2026-09-07. Reported because the next person will
hit it, not because we are still blocked.**

The hackathon rules say an account arrives automatically: *"receiving 20 free
CALL-E calls upon creating a new account (follow the setup instructions at
`CALLE-AI/call-e-integrations`)"*. That is the expectation we started from, and
it is what made the failure hard to diagnose — nothing said account creation was
a separate, manual step, so we assumed we were holding the CLI wrong.

Here is the exact sequence, so it can be reproduced or ruled out.

> Following the official installation guide, `npx @call-e/cli auth login
> --start-only --no-browser-open` returns a valid brokered session
> (`pending_status: PENDING`, ~23 minute TTL), so the broker is healthy. The
> session URL lands on `dashboard.heycall-e.com/login`, which offers sign-in
> only.
>
> There is no sign-up path anywhere in the product. The `awesome-phone-call-agents`
> README's "Sign up now!" links to `heycall-e.com`, whose only two auth links —
> `Login` and `START CALLING` — both point at that same login page. The
> repository's 176 files contain no registration command and no registration
> endpoint.
>
> Checking the OAuth metadata: `/.well-known/oauth-protected-resource` on the
> MCP host names `dashboard.heycall-e.com/mcp-auth` as the authorization
> server. Its metadata exposes a `registration_endpoint`, but that is RFC 7591
> Dynamic **Client** Registration — it registers OAuth clients, not users.
>
> So the CLI and the broker were healthy the whole time. What is missing is a
> way for a new user to become a user, and the install guide does not say that a
> human has to provision the account.

**How it resolved:** the account was provisioned, and the allocation later
raised to roughly 200 calls. Nothing in the tooling changed; the wait was the
whole problem.

**Suggested fix, in priority order:**

1. Say it in the installation guide, in one line, at the top: whether an account
   is self-serve or provisioned, and if provisioned, the expected wait. A known
   two-day wait costs a participant nothing. An unknown one costs them the days
   they spend assuming they typed something wrong.
2. Make `auth login` say it too. The command returns a healthy pending session
   and sends the user to a page that cannot help them; it could name the step
   that is missing.
3. Fix the `heycall-e.com` "Sign up now!" link, which lands on sign-in.

Why this one first: for us it cost days of a one-week build, and it is the only
item here that can cost the sponsor entries rather than goodwill.

---

## 2. A multi-recipient call returns no `transcript_turns`; the same numbers dialled one at a time do

**This is the item we would most like acted on, and it is reproducible.**

A call created with three recipients completed normally: all three connected,
ran for 49, 49 and 62 seconds, and came back `task_completed: true` at
completion confidence `1.0`, each recipient carrying a populated
`structured_result` from our `recipient_result_schema`.

**Every recipient had an empty `transcript_turns`.** The spoken content was
present, but only inside the per-recipient `summary` as lowercase prose. This
was not a timing artifact: the call was re-fetched later and the turns never
appeared.

Twenty-five minutes later, the same three numbers were dialled again from the
same account, one recipient per call. We then ran both arms again, back to
back, an hour and a half after that:

| Same three numbers, same account | One call, three recipients | Three calls, one recipient each |
| --- | --- | --- |
| First run, 19:19 and 19:42 UTC | 0, 0, 0 | 7, 15, 7 |
| Second run, 20:53 UTC, both arms together | 0, 0, 0 | 8, 14, 6 |

**You can run this yourself.** The second run is a single command in our
repository, and it keeps only the counts — no transcript, no call id, no
structured result:

```bash
npm run probe:fanout -- --to +1... --to +1... --to +1... --live
```

It dials each number once per arm, waits for both to settle, and prints the
table above. Six calls. If it does not reproduce, it says so and prints both
arms anyway.

**Why it matters more than it looks.** `recipient_result_schema` is documented
as the primitive for batch work — *"useful for batch calls where each recipient
needs their own outcome"* — and it does return a per-recipient result. But the
only evidence a client has for checking that result against what was actually
said is `transcript_turns`, and on that path there is none. Anyone extracting
per-recipient results from a batch and wanting to verify them is choosing
between fan-out and verifiability without being told they are choosing.

We rebuilt our dispatch around it: a batch is now one call per target. That
works, and it costs the same, but it is a workaround for something a caller
cannot discover from the API reference.

**Suggested fix,** in order of preference:

1. Return `transcript_turns` per recipient for multi-recipient calls, since the
   content clearly exists — it reaches the summary.
2. Failing that, say so in the `recipient_result_schema` documentation, in one
   sentence: transcript turns are available for single-recipient calls only.
3. Either way, a `transcript_available` boolean on the recipient would let a
   client tell "nothing was said" from "we do not return that here", which are
   very different facts to build on.

---

## 3. `task` is capped at 255 characters and this is not documented

The Calls API rejects a longer `task`. Nothing in the quickstart, the calls
guide, or the API reference states the limit, so the first encounter is a
rejected request.

It is a tight budget once a task has to carry a goal, a menu-routing
instruction, and an AI-disclosure line. We ended up compiling the task from
prioritised segments and dropping the lowest-priority one to fit.

**Suggested fix:** state the limit in the quickstart beside the `task` field,
and return the limit and the submitted length in the error body.

---

## 4. Webhook deliveries are unsigned, and the SDK is the only place that says so

`@call-e/calle` deprecates `webhooks.verify()` and `webhooks.unwrap()` with the
reason in the JSDoc: *"Current CALL-E webhook deliveries are not signed."* The
webhooks documentation page does not carry that warning.

The consequence is worth spelling out for developers: anyone who learns a
webhook URL can post to it, so a delivery cannot be treated as a source of
truth. Our receiver reads one call id out of a delivery and then asks the API
what happened, refusing any id it did not itself dispatch.

**Suggested fix:** put the sentence from the SDK on the webhooks page, with the
re-fetch pattern as the recommended handling. Signing them later would be
better still.

---

## 5. An idempotent replay is indistinguishable from a new call

This is issue [#315](https://github.com/CALLE-AI/awesome-phone-call-agents/issues/315)
and we hit it too, so treat this as a second data point rather than a new
report.

Reusing a key answers `201 Created` with the existing call. A client that
retries after an ambiguous failure gets a response that looks exactly like a
fresh dispatch, and no phone rings. We now keep a local ledger of issued keys
purely to tell the two apart.

**Suggested fix:** an `Idempotent-Replay: true` response header, or a boolean on
the call object. Either is enough and neither breaks an existing client.

---

## 6. A timeout does not mean no call happened, and clients will assume it does

Issue [#283](https://github.com/CALLE-AI/awesome-phone-call-agents/issues/283)
records a call that stayed queued for 49 minutes, raised `CalleTimeoutError` in
`waitForResult`, and then dialed and completed.

The SDK's timeout looks like a normal client timeout, and the normal reflex is
to retry. On a telephone that reflex places a second real call to a real
person. We ended up classifying failures three ways — `retryable`,
`deterministic`, and `reconcile` — specifically because two buckets cannot
express this.

**Suggested fix:** say it in the `waitForResult` documentation, in one sentence,
in the imperative: *a timeout is not a failed call; fetch the call by id before
deciding anything.* A distinct error type would be better than a note.

---

## 7. `structured_result` gives no way to tell "asked and unclear" from "never asked"

Issue [#316](https://github.com/CALLE-AI/awesome-phone-call-agents/issues/316)
is the one this whole project was built around, so this is a vote for its
priority rather than a new report.

A schema-valid, high-confidence value can come back for a question the agent
never raised. `completion_confidence` does not separate the cases: it scores the
task, not the field. Only `attempts[].transcript_turns` can settle it, and every
caller has to reimplement that check.

**Suggested fix:** per-field provenance — for each key in `structured_result`,
the transcript turn index it was extracted from, or `null` when the model
inferred it rather than hearing it. That single field would let every client
distinguish heard from inferred, and would make most of our Evidence Gate
unnecessary. We would happily trade the code for the primitive.

---

## 8. `task_completed: true` on calls that established nothing

Across five calls to two unrelated automated lines on 2026-09-11, three came
back `task_completed: true` at high confidence — 0.82, 0.78 and 0.84 — while
the same payload's own `summary` and `evidence` recorded that nothing had been
obtained. One summary states the assistant did not navigate the phone tree;
another states no status or availability was provided. The other two calls
returned `false` at 0.82 and 0.85, which was accurate.

Five calls is not a measurement and is not offered as one. The point is that
the flag and the summary in the same response disagreed, three times, so a
client cannot branch on `task_completed` alone.

**Suggested fix:** either derive the flag from the same judgement that writes
the summary, or document that it reports whether the call ran to completion
rather than whether the task succeeded. Right now the name implies the second.

---

## 9. The agent speaks a keypad choice instead of sending one

On two unrelated IVRs the agent responded to a "press 1" prompt by saying the
digit aloud — once as the bare number, once announcing that it was pressing.
Neither system advanced. CALL-E's own summary for one of them described it
without being asked: the assistant spoke a menu choice instead of navigating
the keypad prompt.

Any keypad-gated line is therefore unreachable, which is most published
customer-service numbers.

**Suggested fix:** send DTMF when the task asks for a keypad option, or state
plainly in the docs that DTMF is not supported so nobody designs a workflow
around a tree they cannot traverse.

---

## 10. Waiting through a human transfer is by design, is not documented, and cannot be opted out of

A task instructed the agent to refuse a transfer to a person. Offered one, it
accepted and waited on hold. The instruction was rewritten as a concrete
positive action rather than a prohibition — the framing your own prompt guidance
favours — and the call was placed again. It accepted again.

Support later clarified that this is intended: CALL-E is designed to wait when
a call is transferred to a human agent. That answers *why*, and it turns this
from a bug report into a documentation request. Nothing in the quickstart, the
calls guide or the API reference says it, so the first place a developer learns
it is a bill.

Two calls ran **920.216 s** and **920.139 s**: within a tenth of a second of one
another, so a platform limit rather than a coincidence. Both spent the bulk of
that in a hold queue, the agent answering recorded announcements and
advertisements conversationally until the limit cut the call.

`CreateCallParams` exposes `task`, `recipients`, the result schemas,
`metadata`, `webhookUrl` and `idempotencyKey`. There is no maximum-duration
parameter, and `timeoutMs` governs only how long the client waits for a result,
not how long the call runs. So the caller has no way to bound this: not by
instruction, because the agent does not follow it, and not by parameter,
because none exists.

Three calls to that one line, every one of them ending in the queue, ran 38
minutes and cost **1,551 credits** — 305, 623 and 623, or about 40.8 credits a
minute across all three. At the rate support quoted when reconciling them, one
credit is a cent, so that is **$15.51 for thirty-eight minutes of hold music**,
about 41 cents a minute. A caller who assumes per-call billing and points this
at a queue finds out by arithmetic.

**Suggested fix:** say it in the docs first — one line in the calls guide that
the agent waits through a transfer to a human, beside the note about billing by
duration. Then a `max_duration_seconds` on call creation, so a caller who
cannot use that behaviour can bound it rather than avoid the platform. Hold
detection would help too: an agent that stopped answering recorded
announcements would cut most of this cost on its own.

---

## Smaller notes

- **`calle` on npm is not CALL-E.** There is an unrelated package named `calle`
  at version 1.0.0 with the description `"a"`. The real CLI is `@call-e/cli`.
  Worth a line in the install guide; a typo there installs a stranger's code.
- **The docs site links an `openapi.yaml` that 404s** (the object is missing
  from the bucket), so the machine-readable contract is not actually available.
- **Billing is by duration and the console does not say so anywhere obvious.**
  Roughly 40 credits a minute, and a credit is a cent: a fifteen-minute call
  cost 623 credits, or $6.23. A thirty-second one is negligible.
  The hackathon framing — "20 complimentary calls" — reads as per-call, so a
  participant budgets in calls and is billed in minutes. One line beside the
  balance would prevent it.
- **Three different Discord invites are published**, and they are not obviously
  the same server: `discord.gg/6AbXUzUV8w` in the repository README,
  `discord.gg/SDcGdhgRzj` on heycall-e.com, and
  `discord.com/invite/HP4BhW3hnp` on the Devpost hackathon page. A participant
  looking for help has to guess.
