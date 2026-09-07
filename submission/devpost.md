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
all*. Every one of the 270 projects in this hackathon's repository places calls
and trusts what comes back.

So we built the thing that checks.

**Targeting: Most Practical Use Case.** It replaces a process a discharge
coordinator runs by hand today, and the improvement is measured rather than
asserted.

## What it does

Picture a hospital discharge coordinator. A patient is medically ready to leave
and cannot, because nobody has confirmed a bed. So the coordinator rings eight
care homes, one at a time, through eight phone menus and eight hold queues,
asking the same two questions.

HOLDLINE asks all eight at once — one dispatch, one idempotency key — and then
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
coordinator starts again tomorrow. In our corpus, **one answer in four from a
plain schema check was never established by the conversation.** HOLDLINE
returns none of those.

### 2 — Quality of the Idea

Almost every phone-agent project treats the returned result as the answer. The
non-obvious move is to treat it as a *claim*, and to check it against what was
said out loud. The distinction we had to invent — `unattributed`, meaning *a
question was asked and answered but I cannot pin it to this field* — is what
separates "I cannot confirm this" from "this never happened". Conflating those
two is what made our first version unusable, and we only found that by
measuring.

### 3 — Technical Implementation

CALL-E is imported and exercised at runtime through the genuine `CalleClient`;
only the network underneath it is replaced in tests. 151 tests, no credentials,
no calls. Strict E.164, unconditional emergency-prefix refusal, output
redaction that covers echoed metadata and provider error bodies, idempotency
keys derived from the authorizing record with no timestamp parameter to misuse,
and failures sorted into `retryable` / `deterministic` / `reconcile`. The
`awesome-phone-call-agents` skill was validated with that repository's own
`scripts/validate_repository.py` before submission.

### 4 — Product Experience & Demo

`npm start` opens an operations console on loopback with the discharge batch
already loaded — no API key needed, nothing dials until you tick the
confirmation. One dispatch produces a verified answer and a withheld one side
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
no calls — and when we did get an account and dialled for real, nothing above
that line had to change.

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

**Three real calls broke things I had written down as true.** By the time an
account existed the whole engine was built against the local fake, so the calls
were a test of my assumptions as much as of the platform.

The first showed CALL-E labels the automated system as `user` — there is no
`unknown` speaker at all. My route cache had assumed the opposite and would
have reported "a person answered at ten seconds" on a recorded greeting. The
second showed my own traversal check was worthless: it matched the word "press"
in the recording's greeting and declared success on a call where the agent
pressed nothing. The third showed that framing a task as prohibitions makes the
agent leave — told what not to do, it announced it was not requesting help and
hung up 5.6 seconds in.

They also showed the thing I wanted: an agent stating a purpose, an IVR
confirming it — *"you're calling to track a package, right?"* — and routing it.
By speech. The keypad was offered and never used, so DTMF traversal is still
unobserved, and the repository says so.

One of those calls is kept whole and masked as a fixture, and the gate is run
over it in the test suite. CALL-E's own summary of it was candid — the system
would not continue without a tracking number — while `taskCompleted` came back
`true` at 0.9 confidence. The gate verifies one field and quotes the line that
established it, a sentence genuinely spoken on the call. It withholds
`reached_human: "no"`, which was correct: nobody human came on the line, but
nothing was *asked* that the value answers, because the truth is in what did
not happen. We cannot credit a fact established by absence, we wrote that down
as a limit rather than tuning it away, and there is a test holding us to it.

## Accomplishments that we're proud of

**We published our own failure rate.**

```
What a caller ends up believing:
  Trusting structured_result   320 answers, 80 never established  25.0% wrong
  Through the gate              80 answers,  0 never established   0.0% wrong
  Real answers withheld         80

Invented values caught         80/80  100.0%
Direct asks passed             80/80  100.0%
Paraphrases wrongly accused     0/80    0.0%
Paraphrases withheld           80/80  100.0%
```

The withheld-answers line is the cost of the zero above it, and we print it
every run. A paraphrase
is still withheld, because an answer that cannot be attributed to a question
should not be stored as fact. A benchmark containing only the cases a system
handles is marketing.

151 tests, no network and no credentials. Three production dependencies. The
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

Keypad traversal, which is still unobserved — every system we reached accepted
speech, so the agent used speech, and we will not claim a capability we have
not watched work. Then a Slack action so a ward clerk can ask from where they
already work, durable stores behind the ledger interfaces, and better probe
tooling to push that withheld-paraphrase number down. The gate's blind spot for
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
