# Demo video

Hard limit: **under 3 minutes**, public on YouTube or Vimeo. It is one of four
equally weighted judging criteria, so it is worth as much as the entire
implementation.

## Before recording

```bash
npm test          # 151 green on screen is worth five seconds of footage
npm run eval      # have the measured figures ready to show
npm run replay    # the real call, judged; this is the 1:35 shot
npm start         # http://127.0.0.1:4173
```

Set the browser to a clean window, no bookmarks bar, no other tabs. The
default batch is the discharge-planning scenario; leave it as it loads. The console
adapts to the system theme; dark reads better on video.

The account exists and three real calls have been placed, so there is real
footage to show — see 1:35. The console itself is still simulated and labels
itself so on screen; say that out loud once rather than letting a viewer catch
it. See Honesty below.

## Shot list

### 0:00 – 0:18 · The problem, stated once

Screen: the console at rest, four care homes listed, nothing run yet.

> "A patient is medically ready to leave hospital and can't, because nobody has
> confirmed a bed. So a coordinator rings eight care homes, one at a time,
> through eight phone menus."
>
> "This one came back saying it can take the patient. High confidence. Valid
> against the schema. The agent never asked."

### 0:18 – 0:45 · Plan

Screen: click **Plan**. Point at three things and nothing else.

> "Two questions, four homes, one dispatch. HOLDLINE compiles it into the 255
> characters the API allows and shows you exactly what will be said."

Point at the character meter, then the refused row.

> "The last number has a space in it. It is refused before anything dials, not
> halfway through the batch."

Then the idempotency key.

> "The key comes from the batch record, never from the clock. Running this again
> fetches the call that already happened instead of ringing anyone twice."

### 0:45 – 1:15 · The wait, which is the whole point

Screen: tick the confirmation, click **Place calls**. Now say nothing for five
seconds and let the board run.

```
Oakfield Care Home    holding   0:30   on hold for 16s
Riverside Nursing     holding   0:46   on hold for 32s
Belmont House         holding   1:26   on hold for 72s
```

> "Three homes, one dispatch, all three sitting in the queue at once. That
> clock is the call's own clock. Nobody is listening to this."

Let it reach `2:12 · a person answered` before speaking again. **Do not cut
this short.** The climbing clock is the product.

### 1:15 – 1:35 · The moment

> "Three reached, the fourth refused before dialing. Different answers."

Point at Oakfield, green.

> "Verified. And here is the sentence that established it — the actual turn the
> agent spoke."

Point at Riverside, red.

> "Same batch. The nursing level came back populated and confident. But no
> question in that call could have produced it. So it does not come back.
> It is withheld, with the reason."
>
> "That's a patient who doesn't get moved tomorrow on an answer nobody gave."

Pause on the withheld field for a full beat. **This is the shot the whole
submission rests on. Do not rush it.**

### 1:35 – 2:05 · Why it is not a trick

Screen: cut to the terminal, `npm run eval`.

> "CALL-E's own issue tracker records this: a call that skipped a question and
> returned a value anyway, with nothing in the response to tell the difference.
> So we measured it. Four hundred labelled cases, offline."

Point at the numbers as they read.

> "Every invented value caught. And zero false accusations — a question asked in
> different words is withheld, not called a lie. That last line is the cost, and
> we publish it."

### 2:05 – 2:35 · It is a primitive, not an app

Screen: the MCP tool list, or the SKILL.md.

> "It is an MCP server too, so any agent gets three tools. Two of them can't
> dial. The one that can has to be told, in the same request, that dialing is
> what you meant. An agent can't reach a telephone by accident."

Optional if time: `HOLDLINE_SIMULATE=1 npm run mcp`.

### 2:35 – 2:55 · Close

Screen: back to the cards, the verified one and the withheld one together.

> "A phone agent that always answers is easy. One that tells you when it
> doesn't know is the one you can actually deploy."

## Honesty

Say this once, plainly, around 1:35 — not in small print:

> "The console you just saw runs against a local simulator. We did place three
> real calls, and they're in the repo — they're how we found out two things we'd
> documented were wrong."

Reasons to keep it in rather than trim for time:

- The console labels every simulated response `simulated: true` on screen. A
  viewer will see it. Saying it first is better than being caught by it.
- The real calls are the stronger half of that sentence. They confirmed CALL-E
  navigates a real IVR, and they broke two of our own assumptions — that is a
  better story than a clean run.
- Do not claim keypad traversal. The systems reached accepted speech and the
  agent used speech. Say "it navigated a real phone tree" and stop there.

The twenty seconds of real footage is `npm run replay`, and it is the strongest
shot in the video because nothing about it is staged:

```
  37 turns  ·  2 fields  ·  no call placed

  What the call reported
    department_confirmed     "yes"
    reached_human            "no"
    (confidence)             0.9

  What the transcript supports
    department_confirmed     verified
                             "I'm calling to reach the package tracking option..."
    reached_human            unattributed

  What a caller is given
    department_confirmed     "yes"
    reached_human            null   (withheld)
```

> "That is a real call to a real phone tree. It came back at nine-tenths
> confidence. One field is verified, and there is the sentence that established
> it. The other is withheld."

Then, if there is time, the honest half — it is worth more than it costs:

> "And the withheld one was *right*. Nobody human came on the line. But nothing
> was asked that could establish that, so we don't get to claim it. We'd rather
> hand back a gap than a fact we can't point at."

## What not to do

- No slides, no logo animation, no music bed. Three minutes is short.
- Do not read the README aloud. Show the product doing the thing.
- Do not show a raw phone number. Everything on screen is masked already —
  keep it that way, including the input textarea if you zoom in.
- The board replays the call clock at 25× and says so on screen. Do not imply
  it is real time.
- Do not claim seconds saved as a measured result. `seconds on the phone` on
  the stat strip comes from simulated transcripts. Say "this is what it would
  count" or leave the strip out of frame.
- Do not speed the video up to fit. Cut a section instead.

## Publishing

- Public, not unlisted-only — the rules say publicly visible.
- Title: `HOLDLINE — phone answers you can actually trust`
- Description: link the repository and the pull request, and repeat the
  simulation note in the first two lines.
