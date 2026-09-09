# Devpost submission text

Paste section by section into the Devpost form. Written for a judge reading
their fortieth project of the evening, not for a developer browsing the repo —
that audience is the README's.

---

## Tagline

*(Devpost's short "elevator pitch" field, 200 characters)*

> Phone answers you can act on. HOLDLINE asks many places at once and returns
> only what the call actually established — a question the agent skipped comes
> back empty, not wrong.

---

## Inspiration

We found it in CALL-E's own issue tracker.

Issue [#316](https://github.com/CALLE-AI/awesome-phone-call-agents/issues/316):
a developer asked their agent to confirm an address. The agent never raised the
question during the call. The result came back populated anyway —
`address_correct: "unclear"`, valid against the schema, high confidence. They
only noticed because the summary happened to mention the agent moving on.

That is a small bug and an enormous problem. A call result tells you what the
model concluded. It does not tell you what was said out loud, and nothing in
the response distinguishes *asked and not understood* from *never asked at
all*.

We are not the only project in this repository that noticed. `verify-by-phone`
grounds each answer in a transcript span, `verity-verification-core` gates a
`task_completed` claim behind an independent read-back, and
`incident-escalation-call` records an acknowledgement only from words the
recipient spoke. Checking the transcript is, correctly, becoming the house
style.

What is still missing everywhere — including in ours, until measurement forced
it — is the distinction *underneath* that check. **Not confirmed** and
**invented** are different states, and a gate that conflates them is unusable:
ours accused 100% of paraphrased questions of being fabricated on its first
run. So HOLDLINE returns six verdicts rather than a boolean, and publishes what
telling them apart costs: 50 real answers withheld, printed on the same screen
as the zero it buys.

So we built the thing that checks, and then measured the thing that checks.

**Targeting: Most Practical Use Case.** It replaces a process a discharge
coordinator runs by hand today, and the improvement is measured rather than
asserted.

## What it does

Picture a hospital discharge coordinator. A patient is medically ready to leave
and cannot, because nobody has confirmed a bed. So the coordinator rings eight
care homes, one at a time, through eight phone menus and eight hold queues,
asking the same two questions.

HOLDLINE asks all eight at once — one batch, one authorizing record — and then
does the part that matters: **it checks every answer against the transcript the
agent actually spoke.**

Each place comes back with a verdict:

- **verified** — the agent raised the topic and a usable answer came back, and
  you get the sentence that established it, quoted.
- **asked_but_unclear** — asked, no usable answer.
- **unattributed** — a question was asked and answered, but none of this
  field's probes match it, so the answer cannot be pinned here.
- **never_asked** — nothing was asked that this value could answer. If a value
  came back anyway, it is flagged and withheld.

A withheld field is returned as `null` with the reason. A missing answer is a
visible gap; a wrong answer is invisible until a patient spends another night
in a hospital bed.

That fourth verdict is the one that would have caught issue #316.

## Against the judging criteria

### 1 — Real World Impact

A patient who is medically ready to leave hospital occupies a bed until someone
confirms another one. The coordinator making that happen works a phone list.
Assume eight homes per placement, five placements a week, six minutes a call
including the menu and the hold: **four hours a week on the telephone**, per
coordinator. Those are assumptions, stated so you can change them.

The expensive failure is not the four hours. It is a "yes, we have a bed" the
call never actually established — the patient stays another night and the
coordinator starts again tomorrow. In our corpus, **half of what a plain schema
check would have handed the caller was never established by the conversation** —
200 answers out of 350. HOLDLINE returns none of those.

### 2 — Quality of the Idea

Treating the returned result as a *claim* rather than an answer is no longer a
lonely position in this repository, and we would rather say so than pretend
otherwise. The non-obvious part is what happens after you decide to check.

Every check needs a verdict for *the question was asked, and answered, but I
cannot pin that answer to this field*. Without it, a lexical check calls every
paraphrase a fabrication — ours did, on 100% of them, and the number is why
`unattributed` exists at all. It is the difference between "I cannot confirm
this" and "this never happened", and those two sentences send a discharge
coordinator to different places.

The second non-obvious part is publishing the bill. Withholding is not free: it
costs 50 real answers on our own corpus, and that line prints on every run
beside the zero it buys. A benchmark containing only the cases a system handles
is marketing. We would rather be measured than admired.

### 3 — Technical Implementation

CALL-E is imported and exercised at runtime through the genuine `CalleClient`;
only the network underneath it is replaced in tests. 157 tests, no credentials,
no calls. Strict E.164, unconditional emergency-prefix refusal, output
redaction that covers echoed metadata and provider error bodies, idempotency
keys derived from the authorizing record with no timestamp parameter to misuse,
and failures sorted into `retryable` / `deterministic` / `reconcile`. The
`awesome-phone-call-agents` skill was validated with that repository's own
`scripts/validate_repository.py` before submission.

### 4 — Product Experience & Demo

`npm start` opens an operations console on loopback with the discharge batch
already loaded — no API key needed, nothing dials until you tick the
confirmation. One batch produces a verified answer and a withheld one side
by side, each verified field quoting the sentence that established it. The same
engine is an MCP server, where two of the three tools cannot dial at all.

## How we built it

TypeScript throughout — the CALL-E SDK, an MCP server, and a small operations
console with no framework and no build step.

The decision that shaped everything: the CALL-E SDK accepts an injectable
`fetch`, so we implemented the **wire contract** — `POST /v1/calls`,
`GET /v1/calls/{id}`, snake_case bodies, the `Idempotency-Key` header — as a
fake transport and handed it to the genuine `CalleClient`. Our engine talks to
the real SDK; only the network is replaced. Tests need no credentials and place
no calls.

That decision paid for itself and then charged us once. Everything above the
transport survived contact with a real telephone except one thing — the
dispatch itself, which a live batch retired outright. The fake had been
modelling the documentation, and the documentation was not the telephone.

We made that fake adversarial rather than convenient. It reproduces CALL-E's
*documented failure modes*, each traced to a public issue: a confident result
for a question that was skipped (#316), a call that stays queued past the
client's patience and dials afterwards (#283), one that never reaches a
terminal state (#305), a long silence before the agent speaks (#295), and a
replayed idempotency key that answers `201 Created` with the existing call and
looks exactly like a new one (#315).

Writing against those instead of a happy path produced the parts we are most
confident in: failures sorted into `retryable`, `deterministic` and
**`reconcile`**, because a timeout does not mean no call happened and retrying
one rings a second real person.

## Challenges we ran into

**The first live batch we ever placed took away the architecture.**

The engine was built on what looked like the obvious primitive: CALL-E takes one
`task` and a list of `recipients`, so a fan-out is one dispatch, one idempotency
key, many recipients. Every test passed. The console demo worked. It worked for
a week.

Then we dialled three real numbers in one dispatch. All three connected, ran for
49, 49 and 62 seconds, and came back `task_completed: true` at confidence
`1.0`, each recipient carrying a populated result. **Every recipient came back
with zero transcript turns.** The spoken content existed only as a prose
`summary`.

Our gate did the one thing it is for: it refused all three. Reading the summary
instead would have been the exact failure we accuse everyone else of — a summary
is what the model concluded — and it did not. Correct, and useless: a batch that
can verify nothing is not a product.

So we dialled the same three numbers again twenty-five minutes later, one call
per target:

| Same three numbers, same afternoon | Transcript turns | Result |
| --- | --- | --- |
| One dispatch, three recipients | 0, 0, 0 | everything withheld |
| Three dispatches, one recipient each | 7, 15, 7 | two verified, one withheld |

A multi-recipient call does not return transcript turns and a single-recipient
call does, and nothing in the API reference says so. We rebuilt the dispatch:
one call per target, sent together, each deriving its own idempotency key from
the same authorizing record. The promise is unchanged — one question, many
places, a verdict each — and reconciling one target can no longer re-dial the
other two, which is better than what it replaced.

**Our own fake had been hiding it.** We built the fake transport from the
documentation, so it returned transcripts for every recipient of a
multi-recipient call, and the batch path passed its tests all week. A fake
built from documentation models the documentation. Only a telephone models the
telephone.

**The measurement said our core feature was broken.** We built an evaluation
harness over 400 labelled cases to turn "the gate catches invented values" into
a number. First run: it caught 100% of them — and accused **100% of paraphrased
questions** of being fabricated. Topic detection is lexical, and an LLM agent
paraphrases constantly. In production it would have flagged nearly every call
as a lie.

The fix was the `unattributed` verdict: count the question-and-answer exchanges
no probe claims, and only flag a value with no exchange left to have come from.
*Not confirmed* and *invented* are different states and the gate had been
conflating them. We would never have found that by reasoning about it.

**Task text is capped at 255 characters.** Undocumented anywhere we could find,
and a real constraint once a goal, a menu-routing hint and a disclosure have to
share the budget. We compile the task from prioritised segments and drop the
lowest first — and fail loudly rather than truncate a required instruction and
ship a call that asks half a question.

**Fifteen real calls broke things I had written down as true.** By the time an
account existed the whole engine was built against the local fake, so the calls
were a test of my assumptions as much as of the platform. No transcript,
recording or call artifact from any of them is kept in the repository — what
follows is what they changed, in my own words.

The first showed CALL-E labels the automated system as `user` — there is no
`unknown` speaker at all. My route cache had assumed the opposite and would
have reported "a person answered at ten seconds" on a recorded greeting. The
second showed my own traversal check was worthless: it matched a menu word in
the recording's own greeting and declared success on a call where the agent
pressed nothing. The third showed that framing a task as prohibitions makes the
agent leave — told what not to do, it announced it was not requesting help and
hung up 5.6 seconds in.

**Then one of them did the thing this project was an argument about, and I did
not have to construct it.**

A call came back with a value that was a whole sentence reporting that nothing
had been established — that the system had stayed in its menu and ended before
answering. My gate marked it **`verified`**. The usable-value check knew only
short sentinel tokens like `unknown` and `n/a`, so a refusal written in prose
sailed straight through it.

The unit suite missed it. So did all 400 evaluated cases — because every value
in that corpus was one word long. The measurement could not see its own worst
case.

I fixed it in that order, and the order is the point: I added the class to the
corpus first, measured the damage, and only then changed the check. Both
directions are measured now, `asked_prose_non_answer` and
`asked_prose_answered` — 50/50 caught, 0/50 genuine prose answers wrongly
withheld. Correcting the metric moved the headline figure from an unearned
`0.0% wrong` to the truth, and then the fix earned it back.

Some of the rest was my fault too and it is written down that way. One task
text ended with *"if a person answers, thank them and end the call"*, and since
CALL-E labels an automated system as a person, the greeting almost certainly
fired my own exit instruction — two calls hung up at six seconds. Removing the
clause produced a call that ran 194 seconds. The bug was mine. It still does
not explain a completion flag reading `true` at full confidence sitting on top
of results that said `"unknown"`.

It also settled a question I had been guessing at. **The keypad boundary is now
observed rather than assumed**: a real system stopped accepting speech, required
DTMF, and the call died there because the agent had only a voice. HOLDLINE does
not press keys. That is written down as a limit, not dressed up as a feature.

They carry an honest cost too, and it is older than any of this. A fact
established by *absence* cannot be credited. When nobody human ever comes on
the line, `reached_human: "no"` is **correct** — and the gate withholds it
anyway, because nothing was *asked* that the value answers; the truth sits in
what did not happen. We wrote that down as a limit rather than tuning it away.

## Accomplishments that we're proud of

**We published our own failure rate.**

```
What a caller ends up believing:
  Trusting structured_result   350 answers, 200 never established  57.1% wrong
  Through the gate             100 answers,   0 never established   0.0% wrong
  Real answers withheld         50

Invented values caught         50/50  100.0%
Direct asks passed             50/50  100.0%
Paraphrases wrongly accused     0/50    0.0%
Paraphrases withheld           50/50  100.0%
Prose non-answers caught       50/50  100.0%
Prose answers wrongly withheld  0/50    0.0%
Mentions without a question    50/50  100.0%
```

The withheld-answers line is the cost of the zero above it, and we print it
every run. A paraphrase
is still withheld, because an answer that cannot be attributed to a question
should not be stored as fact. A benchmark containing only the cases a system
handles is marketing.

157 tests, no network and no credentials. Three production dependencies. The
skill was copied into a clone of `awesome-phone-call-agents` and validated with
that repository's own `scripts/validate_repository.py` before submission.

## What we learned

**CALL-E's webhooks are not signed** — the SDK says so itself, deprecating its
signature helpers with that reason. Anyone who learns your endpoint URL can
post to it. So our receiver treats a delivery as a doorbell, not a document: it
reads one call id, refuses any id it did not dispatch, and asks the API what
actually happened. Nothing from the payload reaches the gate or the ledger.

**A timeout is the dangerous case, not the boring one.** Issue #283 records a
call that timed out client-side and then dialed and completed 49 minutes later.
Most clients sort failures into retry or give up; on a telephone you need a
third bucket that means *go find out what happened*.

**An unknown outcome and a known failure need different words.** Half of what
we built is that distinction, in one form or another.

## What's next

Pressing keys. We now know exactly why it matters: a real carrier line stopped
accepting speech mid-call, required a keypad selection, and hung up on an agent
that had only a voice. That is the single clearest thing the live calls
taught us about where this breaks.

Then a Slack action so a ward clerk can ask from where they already work,
durable stores behind the ledger interfaces, and better probe tooling to push
that withheld-paraphrase number down. The gate's blind spot for
facts established by absence is the one we most want to fix properly, and we
would rather solve it than quietly widen the definition of "verified".

## Built With

`typescript` · `node.js` · `@call-e/calle` · `model-context-protocol` ·
`vitest` · `zod`

---

## Reminders for the form

- Pull request URL to `CALLE-AI/awesome-phone-call-agents`
- Demo video, under 3 minutes, **public** on YouTube or Vimeo
- The email address on the CALL-E account
- Optional demo URL — the console runs on loopback, so leave this blank unless
  it gets deployed
- Submit on **13 September**. The deadline is 23:45 SGT on the 14th, which is
  15:45 UTC — 11:45 in New York, 17:45 in Madrid.
