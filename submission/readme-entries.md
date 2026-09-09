# README entries

Two lines to add to `README.md` in `CALLE-AI/awesome-phone-call-agents`. Both
were inserted into a working copy and the validator passed.

## Skills section

The list is loosely alphabetical. Place this immediately **before** the
`voice-preflight` entry, which is where the `h` slot currently falls:

```markdown
- [`holdline`](skills/holdline/) - Asks one question of many places by phone at once and returns only the fields the transcript supports, flagging values a call reports for questions it never asked.
```

## Apps section

External repository links are the established pattern here — `CallParity`,
`CallmeMaybe` and `Later, Me.` all point outward. Place this immediately
**before** the `Later, Me.` entry:

```markdown
- [HOLDLINE](https://github.com/Elioz404/HOLDLINE) - Evidence-gated batch phone enquiries with per-target verdicts checked against the transcript, a freshness ledger that skips repeat calls, and an MCP server with a no-account simulation mode.
```

## Format rules

From `CONTRIBUTING.md`:

```markdown
- [Project Name](https://example.com) - One sentence explaining why this is useful for AI-agent phone-call workflows.
```

A single hyphen separator, one sentence, short and factual. The repository
explicitly rejects marketing language: `A great tool for calling people!` is
given as the example of what not to write.

**Before pushing, make the repository public.** The Apps entry links to it, and
a link a reviewer cannot open is worse than no entry.
