/**
 * The demo narration, in order, as one source of truth.
 *
 * `caption` is what appears on screen and may carry emphasis markup.
 * `speech` is what the voice reads, and is plain text — the two differ only
 * where the written form would be read badly aloud.
 *
 * `src/tools/narration.ts` turns these into audio and measures each line.
 * `src/tools/video.ts` holds each caption for exactly as long as its line of
 * audio runs, so the picture is cut to the voice rather than the other way
 * round. `src/tools/mixdown.ts` lays the audio back over the recording and
 * writes the subtitle file from the same timings.
 *
 * Adding a line here changes the video, the narration and the subtitles
 * together. There is nowhere else to edit.
 */

export interface ScriptLine {
  /** Marks where a new on-screen segment begins. Used only for readability. */
  readonly segment?: string;
  /** On-screen text. `<b>` reads as affirmative, `<i>` as the withheld case. */
  readonly caption: string;
  /** What the voice says. Plain text. */
  readonly speech: string;
}

export const SCRIPT: readonly ScriptLine[] = [
  {
    segment: "the problem",
    caption: "A patient is medically ready to leave hospital, and can’t — because nobody has confirmed a bed.",
    speech: "A patient is medically ready to leave hospital, and can't, because nobody has confirmed a bed.",
  },
  {
    caption: "So a coordinator rings eight care homes, one at a time, through eight phone menus.",
    speech: "So a coordinator rings eight care homes, one at a time, through eight phone menus.",
  },
  {
    caption: "HOLDLINE asks all of them at once — and returns <b>only the answers the calls actually established</b>.",
    speech: "Holdline asks all of them at once, and returns only the answers the calls actually established.",
  },

  {
    segment: "plan",
    caption: "Two questions, four homes, one batch — compiled into the <b>255 characters</b> the API allows.",
    speech: "Two questions, four homes, one batch, compiled into the 255 characters the A P I allows.",
  },
  {
    caption: "The fourth number is malformed. It is refused <b>before anything dials</b>, not halfway through the batch.",
    speech: "The fourth number is malformed. It's refused before anything dials, not halfway through the batch.",
  },
  {
    caption: "Every place gets its own idempotency key, derived from the batch record and never from the clock.",
    speech: "Every place gets its own idempotency key, derived from the batch record, and never from the clock.",
  },

  {
    segment: "on the line",
    caption: "Three homes on the line at once, each one working its own menu. That clock is the call’s own clock — nobody is listening to this.",
    speech: "Three homes on the line at once, each one working its own menu. That clock is the call's own clock. Nobody is listening to this.",
  },
  {
    caption: "This console runs against a local simulator, and labels itself so — on screen, throughout.",
    speech: "This console runs against a local simulator, and labels itself so. On screen, throughout.",
  },

  {
    segment: "the verdicts",
    caption: "Three reached. Five answers established. <i>One withheld.</i>",
    speech: "Three reached. Five answers established. One withheld.",
  },
  {
    caption: "Verified means the agent asked and an answer came back — and here is the sentence that established it.",
    speech: "Verified means the agent asked, and an answer came back. And here is the sentence that established it.",
  },
  {
    caption: "The nursing level came back populated and confident — but <i>no question in that call could have produced it</i>. That’s a patient not moved tomorrow on an answer nobody gave.",
    speech: "The nursing level came back populated, and confident. But no question in that call could have produced it. That's a patient not moved tomorrow, on an answer nobody gave.",
  },

  {
    segment: "three real calls",
    caption: "Everything so far was simulated. <b>These three were not.</b> Three published lines, three real calls, placed together.",
    speech: "Everything so far was simulated. These three were not. Three published lines, three real calls, placed together.",
  },
  {
    caption: "CALL-E returned the <b>same confident answer for all three</b> — point eight six, point eight eight, point eight two.",
    speech: "CALL-E returned the same confident answer for all three. Point eight six, point eight eight, point eight two.",
  },
  {
    caption: "The gate credited two of them. On the third, <i>the agent never asked</i> — and the platform answered anyway. So that one is withheld.",
    speech: "The gate credited two of them. On the third, the agent never asked, and the platform answered anyway. So that one is withheld.",
  },
  {
    caption: "The words that established the two are <b>not printed here</b>. Real calls leave no transcript in this repository.",
    speech: "The words that established the two are not printed here. Real calls leave no transcript in this repository.",
  },
  {
    caption: "Run as <i>one</i> dispatch of three recipients, this returned <b>no transcript at all</b>. That is why a batch is now one call per place.",
    speech: "Run as one dispatch of three recipients, this returned no transcript at all. That is why a batch is now one call per place.",
  },

  {
    segment: "the numbers",
    caption: "Across 400 labelled cases, <b>more than half</b> of what a caller would have believed was never established by the call.",
    speech: "Across 400 labelled cases, more than half of what a caller would have believed was never established by the call.",
  },
  {
    caption: "Through the gate: <b>zero</b>. And the cost of that is on the same screen — 50 real answers withheld.",
    speech: "Through the gate: zero. And the cost of that is on the same screen. 50 real answers withheld.",
  },
  {
    caption: "A phone agent that always answers is easy. One that tells you when it doesn’t know is the one you can deploy.",
    speech: "A phone agent that always answers is easy. One that tells you when it doesn't know is the one you can actually deploy.",
  },
];
