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
    caption: "Two questions, four homes, one dispatch — compiled into the <b>255 characters</b> the API allows.",
    speech: "Two questions, four homes, one dispatch, compiled into the 255 characters the A P I allows.",
  },
  {
    caption: "The fourth number is malformed. It is refused <b>before anything dials</b>, not halfway through the batch.",
    speech: "The fourth number is malformed. It's refused before anything dials, not halfway through the batch.",
  },
  {
    caption: "The idempotency key comes from the batch record, never from the clock. Re-running fetches the same call instead of ringing anyone twice.",
    speech: "The idempotency key comes from the batch record, never from the clock. Re-running fetches the same call instead of ringing anyone twice.",
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
    caption: "Same batch. The nursing level came back populated and confident — but <i>no question in that call could have produced it</i>. So it doesn’t come back.",
    speech: "Same batch. The nursing level came back populated, and confident. But no question in that call could have produced it. So it doesn't come back.",
  },
  {
    caption: "That’s a patient who doesn’t get moved tomorrow on an answer nobody gave.",
    speech: "That's a patient who doesn't get moved tomorrow, on an answer nobody gave.",
  },

  {
    segment: "the gate, over a saved call",
    caption: "Any finished call can be put back through the gate — no network, no key, nobody dialled.",
    speech: "Any finished call can be put back through the gate. No network, no key, nobody dialled.",
  },
  {
    caption: "One field is <b>verified</b>, and there is the sentence that established it, quoted from the call.",
    speech: "One field is verified, and there is the sentence that established it, quoted from the call.",
  },
  {
    caption: "The other came back populated and confident — but <i>nothing in that call asked it</i>. So the caller gets a gap, not a guess.",
    speech: "The other came back populated, and confident. But nothing in that call asked it. So the caller gets a gap, not a guess.",
  },

  {
    segment: "the call that caught us",
    caption: "Then a live call caught <i>us</i> doing the exact thing we accuse everyone else of.",
    speech: "Then a live call caught us doing the exact thing we accuse everyone else of.",
  },
  {
    caption: "The gate called that verified. Nothing in the unit suite or 400 evaluated cases saw it — free-text answers were never in the corpus.",
    speech: "The gate called that verified. Nothing in the unit suite, or 400 evaluated cases, saw it. Free text answers were never in the corpus.",
  },
  {
    caption: "So we added the class, measured the damage, then fixed it. In that order.",
    speech: "So we added the class, measured the damage, then fixed it. In that order.",
  },

  {
    segment: "the numbers",
    caption: "Half of what a caller would have believed was never established by the call.",
    speech: "Half of what a caller would have believed was never established by the call.",
  },
  {
    caption: "Through the gate: <b>zero</b>. And the cost of that is on the same screen — 57 real answers withheld.",
    speech: "Through the gate: zero. And the cost of that is on the same screen. 57 real answers withheld.",
  },
  {
    caption: "A phone agent that always answers is easy. One that tells you when it doesn’t know is the one you can deploy.",
    speech: "A phone agent that always answers is easy. One that tells you when it doesn't know is the one you can actually deploy.",
  },
];
