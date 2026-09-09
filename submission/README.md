# Submitting

Everything here was checked against the target repository's own tooling on
2026-09-07, not inferred from its documentation. Re-run the checks before
submitting; the repository moves.

## What gets contributed

| Where | What |
| --- | --- |
| `skills/holdline/` | The skill: `SKILL.md`, `references/safety.md`, `references/examples.md`, `references/probes.md`. |
| `README.md` Skills list | One entry. |
| `README.md` Apps list | One entry pointing at this repository. |

The engine is not vendored into the target repository. It is linked from the
Apps list, which is how several existing entries are structured, and it keeps
the contribution to one scoped, reviewable skill — the repository states a
preference for small reusable examples over large frameworks.

## Requirements confirmed by running them

`scripts/validate_repository.py` enforces, for every skill:

- the directory name is a lowercase slug, and `name` in the frontmatter matches it
- `description` is at least 40 characters and mentions phone or call
- a `references/` directory exists containing **both** `safety.md` and `examples.md`
- the skill directory contains **no** `README.md`
- every `references/` or `scripts/` path mentioned in `SKILL.md` actually exists
- English only, no trailing whitespace

`references/examples.md` is required and easy to miss — the validator fails
without it, and nothing in `CONTRIBUTING.md` says so explicitly.

Verified: with `skills/holdline/` and both README entries in place, the
validator prints `Repository validation passed.`

## Steps

```bash
# 1. Fork CALLE-AI/awesome-phone-call-agents, then:
git clone https://github.com/<you>/awesome-phone-call-agents.git
cd awesome-phone-call-agents

# 2. Branch (name already checked against their validator)
python3 scripts/check_branch_name.py --branch feat/holdline-evidence-gated-batch-calls
git switch -c feat/holdline-evidence-gated-batch-calls

# 3. Copy the skill in
cp -r <path-to-this-repo>/skills/holdline skills/

# 4. Add the two README lines — see readme-entries.md for exact text and placement

# 5. Validate. Must print "Repository validation passed."
python3 scripts/validate_repository.py

# 6. Commit, push, open the PR with the body in pull-request.md
git add skills/holdline README.md
git commit -m "feat(holdline): add evidence-gated batch enquiry skill"
git push -u origin feat/holdline-evidence-gated-batch-calls
```

## Then on Devpost

The form needs:

- the pull request URL
- a demonstration video under 3 minutes, public on YouTube or Vimeo
- the email address on the CALL-E account
- optionally a demo URL

Deadline is **14 September 2026, 23:45 SGT** — 15:45 UTC, so 11:45 in New York
and 17:45 in Madrid on the 14th. Submit on the 13th.

## The feedback prize

`feedback.md` holds six written-up items plus smaller notes, ready to file. It
is a separate prize category — five awards of $200 — and it does not compete
with the main submission. File the items separately in the CALL-E Discord and
complete the survey linked from the rules.

## One thing only you can do

### Make the repository public

The Apps entry links to it. A link a reviewer cannot open is worse than no
entry at all.

Screenshots are handled: `npm run gallery` drives a real Chrome against the
console and writes `docs/screenshots/` — nine 1920×1080 images, numbered in
Devpost upload order, each carrying its own caption so it stands alone in a
carousel. The terminal shots print output captured from real runs, not
mock-ups. Re-run it whenever the interface changes.

The video is handled too: `npm run narrate`, `npm run video`, `npm run mixdown`
produce `docs/video/holdline.mp4` (2:42, narrated) and `holdline.srt`.

## Account — resolved

The CALL-E account was the critical-path blocker for several days: the
dashboard offered sign-in with no sign-up path, and other participants reported
the same. It is resolved. Seven live calls were placed on 2026-09-07, and the
call allocation has since been raised to roughly 200.

What that history is still worth is a feedback item, not a blocker — see
`feedback.md` item 1, which is written up as *what happened and how it was
resolved* rather than as an open complaint.

## Two deadlines, not one

Both matter, and only the first is irreversible.

| | When | What it freezes |
| --- | --- | --- |
| Submission | 14 Sep 2026, 23:45 SGT (15:45 UTC) | The Devpost form, the video, the text, the links |
| Judging | 30 Sep – 13 Oct 2026 | Nothing — but this is when a judge opens the pull request |

The pull request can keep improving after the 14th. The video and the Devpost
text cannot. Spend the remaining days accordingly, and submit on the 13th.
