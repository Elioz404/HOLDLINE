# Writing probes

A probe is how the gate recognises that the agent raised a topic. It is a list
of phrases matched case-insensitively against the turns the agent spoke.

```json
{
  "name": "accepts_new_patients",
  "asks": ["new patients", "accepting new", "taking patients"],
  "required": true
}
```

## The trade you are making

Matching is lexical. It cannot see a paraphrase.

If the agent asks *"is your list open, or are you full?"* and the probes only
contain `"new patients"`, the gate finds no match. It does not accuse the field
of being invented — a question was asked and answered, so it returns
`unattributed` — but it does withhold the value. A real answer is lost.

The measured cost, from `npm run eval` over 400 seeded cases:

| | |
| --- | --- |
| Invented values caught | 80/80 — 100% |
| Paraphrases wrongly accused of invention | 0/80 — 0% |
| Paraphrases withheld | 80/80 — 100% |

Every paraphrase in that corpus is withheld. Better probes are the only thing
that moves that number.

## Rules that help

**Write what the agent says, not what the field is called.** The field is
`reference_status`; the agent says *"the status of reference 88431"*. Probe on
`"status of"` and `"reference"`, never on `"reference_status"`.

**Prefer short, common fragments.** `"in stock"` matches far more phrasings
than `"do you have that part in stock today"`.

**Cover the two or three ways a question is normally put.** Reading the task
text aloud and writing down the phrasings you would naturally use gets most of
the way there.

**Do not probe on words the answer contains.** `"yes"` matches nothing useful
and will match the wrong turn. Probes match the agent's turns only, never the
other party's — a caller volunteering information is not the agent verifying
it.

**Avoid a phrase that appears in the greeting or the sign-off.** `"thank you"`
or `"calling on behalf"` appear in almost every call and would mark every field
as asked.

## Regular expressions

An `asks` entry may be a regular expression when a substring is too blunt:

```ts
{ field: "reached_department", required: true, asks: [/am i (through|speaking) to/i, "department"] }
```

Keep them anchored to distinctive vocabulary. A pattern broad enough to match
any question defeats the check entirely — the gate would mark everything asked
and verify values the call never established.

## Checking your probes

Run a call in simulation and read the `supportingTurn` on each field. It quotes
the exact turn the probe matched. If that quote is not the question you meant,
the probe is matching the wrong thing, and the field is being verified against
the wrong evidence.

```bash
HOLDLINE_SIMULATE=1 npm run mcp
```
