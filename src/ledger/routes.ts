/**
 * The route cache.
 *
 * The first call to an institution pays for the phone tree: the menus, the
 * selections, the hold. That path is the same tomorrow. Writing it down turns
 * a one-off cost into a shared one — the second caller gets a task that
 * already knows where it is going.
 *
 * ── A correction, from a real call ─────────────────────────────────────────
 * This module used to assume CALL-E labelled system audio as `unknown` and a
 * person as `user`, and took the first `user` turn to mean somebody had
 * answered. That assumption was written down as load-bearing and possibly
 * wrong. It was wrong.
 *
 * On a real call placed 2026-09-07 there was no `unknown` speaker at all —
 * only `bot` and `user` — and the automated system was labelled `user`
 * throughout:
 *
 *   [10] user: "Thank you for calling the United States Postal Service
 *               customer care center. To hear our privacy policy, press 2."
 *   [56] user: "You have reached us after normal business hours..."
 *
 * Under the old rule that call reported a person answering at ten seconds,
 * which would have made every hold figure meaningless.
 *
 * So the other party is now identified by **what it says**, not by how it is
 * labelled. A turn that talks like a recording is treated as one. Everything
 * else is a candidate person, and when nothing qualifies the module says so
 * with `null` rather than guessing.
 *
 * That is still a heuristic. It will misread a receptionist who opens with
 * "thank you for calling", and it will believe a recording that happens to
 * sound conversational. It is honest about being an inference, which the
 * previous version was not.
 */

import type { CallTranscriptTurn } from "../evidence/types.js";

/** Phrases that identify a turn as an automated menu or queue announcement. */
const MACHINE_MARKERS = [
  "press",
  "menu options",
  "please listen carefully",
  "please hold",
  "your call is important",
  "all of our representatives",
  "for english",
  "para español",
  "to speak with",
  "stay on the line",
  "thank you for calling",
  "you have reached",
  "after normal business hours",
  "this call may be recorded",
  "for quality",
  "main menu",
  "say ",
];

export interface RouteObservation {
  readonly subjectId: string;
  readonly callId: string;
  /** What the agent said while working through the menu, in order. */
  readonly steps: readonly string[];
  /** What the automated system said, in order. */
  readonly prompts: readonly string[];
  /**
   * How long the agent was on the call, from first turn to last.
   *
   * This is the number worth reporting, and the only one here that is measured
   * rather than inferred: every second of it is a second a person did not
   * spend on the telephone, whether or not anyone ever picked up.
   */
  readonly callSeconds: number | null;
  /**
   * Offset of the first turn from the other party that does not read as a
   * recording. A *candidate* person, not a confirmed one — see the note on
   * `soundsAutomated`. Never use it as a hold measurement.
   */
  readonly firstNonSystemTurnAtSeconds: number | null;
  /** The agent narrated working a keypad. Narrow, and often false on a voice IVR. */
  readonly usedKeypad: boolean;
  readonly observedAt: number;
}

/** Does this turn read like a recording rather than a person? */
export function soundsAutomated(text: string): boolean {
  const lower = text.toLowerCase();
  return MACHINE_MARKERS.some((marker) => lower.includes(marker));
}

/**
 * Fewer words than this and a turn tells us nothing either way.
 *
 * Real transcripts are full of speech-recognition debris — the sample call
 * contains a turn whose entire content is the word "To". Treating that as a
 * person answering put the hold figure at fifteen seconds on a call where
 * nobody ever picked up. A fragment is inconclusive, and inconclusive resolves
 * to `null`, not to a person.
 *
 * The cost is a real "Hello?" being ignored. That errs toward reporting an
 * unknown wait rather than inventing a short one, which is the direction this
 * module fails in everywhere else.
 */
const MIN_WORDS_FOR_A_PERSON = 3;

function isFragment(text: string): boolean {
  return text.trim().split(/\s+/).filter(Boolean).length < MIN_WORDS_FOR_A_PERSON;
}

/**
 * Phrases the agent uses when it works a keypad.
 *
 * Kept narrow on purpose, and no longer the whole story. A real carrier call
 * showed the agent navigating an IVR entirely by speech — it said what it
 * wanted, the system confirmed "you're calling to track a package, right?" and
 * moved it to that branch — while saying none of these words. Watching only
 * for keypad language reported "navigated: no" about a call that navigated.
 *
 * So `usedKeypad` answers one narrow question honestly. The broader one — did
 * the agent actually work the tree — is deliberately not answered here. Four
 * heuristics were tried for it and all four scored a call a success that was
 * not; the judgement belongs to whoever reads the transcript.
 */
const KEYPAD_MARKERS = ["selecting", "pressing", "i'll press", "i will press", "choosing", "entering"];

export function observeRoute(input: {
  readonly subjectId: string;
  readonly callId: string;
  readonly turns: readonly CallTranscriptTurn[];
  readonly observedAt?: number;
}): RouteObservation | null {
  const prompts: string[] = [];
  const steps: string[] = [];
  let firstNonSystemTurnAtSeconds: number | null = null;
  let usedKeypad = false;


  for (const turn of input.turns) {
    if (turn.speaker === "bot") {
      const lower = turn.text.toLowerCase();
      if (KEYPAD_MARKERS.some((marker) => lower.includes(marker))) {
        usedKeypad = true;
        steps.push(turn.text);
      }
      continue;
    }

    // Anything not spoken by the agent is the other party, whatever CALL-E
    // labelled it.
    if (soundsAutomated(turn.text)) {
      prompts.push(turn.text);
      continue;
    }
    if (isFragment(turn.text)) continue;
    if (firstNonSystemTurnAtSeconds === null) firstNonSystemTurnAtSeconds = turn.offset_seconds;
  }

  if (prompts.length === 0) return null;

  const offsets = input.turns
    .map((turn) => turn.offset_seconds)
    .filter((offset): offset is number => offset !== null);

  return {
    subjectId: input.subjectId,
    callId: input.callId,
    steps,
    prompts,
    callSeconds: offsets.length > 1 ? Math.max(...offsets) - Math.min(...offsets) : null,
    firstNonSystemTurnAtSeconds,
    usedKeypad,
    observedAt: input.observedAt ?? Date.now(),
  };
}

export interface RouteEntry extends RouteObservation {
  /** How many calls have confirmed this route. */
  readonly timesSeen: number;
}

export class RouteCache {
  private readonly routes = new Map<string, RouteEntry>();

  /** Newer observations replace older ones; the count carries forward. */
  public record(observation: RouteObservation): RouteEntry {
    const previous = this.routes.get(observation.subjectId);
    const entry: RouteEntry = {
      ...observation,
      timesSeen: (previous?.timesSeen ?? 0) + 1,
    };
    this.routes.set(observation.subjectId, entry);
    return entry;
  }

  public get(subjectId: string): RouteEntry | undefined {
    return this.routes.get(subjectId);
  }

  /**
   * A routing hint for the task compiler, or `null` when nothing is known.
   *
   * Only routes where the agent actually navigated produce a hint. Knowing a
   * menu exists is not knowing the way through it.
   */
  public hintFor(subjectId: string): string | null {
    const entry = this.routes.get(subjectId);
    if (!entry || !entry.usedKeypad || entry.steps.length === 0) return null;
    return `Last time the menu path was: ${entry.steps.join(" then ")}`;
  }

  /**
   * Seconds the machine spent on the telephone across every cached route.
   *
   * This replaced a "time until a person answered" figure, which a real call
   * showed could not be computed honestly: a modern voice IVR is written to
   * sound conversational — the sample call's system said "in a few words,
   * please tell me how I can help you" — and no amount of phrase matching
   * separates that from a receptionist.
   *
   * Call duration needs no such judgement. It is the time a person did not
   * spend holding, which is the claim worth making anyway.
   */
  public totalSecondsOnCall(): number {
    let total = 0;
    for (const entry of this.routes.values()) {
      if (entry.callSeconds !== null) total += entry.callSeconds;
    }
    return total;
  }

  public get size(): number {
    return this.routes.size;
  }
}
