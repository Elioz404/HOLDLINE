/**
 * The route cache.
 *
 * The first call to an institution pays for the phone tree: the menus, the
 * selections, the hold. That path is the same tomorrow. Writing it down turns
 * a one-off cost into a shared one — the second caller gets a task that
 * already knows where it is going.
 *
 * It also gives the product its unit of impact. `reachedHumanAtSeconds` is how
 * long the machine waited so a person did not have to, and it is measured from
 * the transcript rather than asserted.
 *
 * **An assumption worth stating.** CALL-E labels transcript turns `bot`,
 * `user`, or `unknown`. This module treats `unknown` turns as system audio —
 * menus, hold announcements — and the first `user` turn as the moment a person
 * answered. That is an inference from the labels, not a documented guarantee,
 * and if CALL-E labels a human `unknown` on some route the hold figure for
 * that route will be wrong. `observeRoute` returns `null` rather than guessing
 * when there is no evidence of a menu at all.
 */

import type { CallTranscriptTurn } from "../evidence/types.js";

/** Phrases that identify a turn as an automated menu or queue announcement. */
const MENU_MARKERS = [
  "press",
  "menu options",
  "please listen carefully",
  "please hold",
  "your call is important",
  "all of our representatives",
  "for english",
  "to speak with",
  "stay on the line",
];

export interface RouteObservation {
  readonly subjectId: string;
  readonly callId: string;
  /** What the agent said while working through the menu, in order. */
  readonly steps: readonly string[];
  /** What the menu said, in order. */
  readonly prompts: readonly string[];
  /** Seconds from call start until a person spoke, when observable. */
  readonly reachedHumanAtSeconds: number | null;
  readonly observedAt: number;
}

const looksLikeMenu = (text: string): boolean => {
  const lower = text.toLowerCase();
  return MENU_MARKERS.some((marker) => lower.includes(marker));
};

/**
 * Read a route out of one call's transcript.
 *
 * Returns `null` when no menu language appears at all — a number that answers
 * directly has no route to cache, and inventing one would poison the hint for
 * every later caller.
 */
export function observeRoute(input: {
  readonly subjectId: string;
  readonly callId: string;
  readonly turns: readonly CallTranscriptTurn[];
  readonly observedAt?: number;
}): RouteObservation | null {
  const prompts: string[] = [];
  const steps: string[] = [];
  let reachedHumanAtSeconds: number | null = null;

  for (const turn of input.turns) {
    if (turn.speaker === "user") {
      // First human voice ends the automated portion.
      if (reachedHumanAtSeconds === null) reachedHumanAtSeconds = turn.offset_seconds;
      break;
    }
    if (turn.speaker === "unknown" && looksLikeMenu(turn.text)) {
      prompts.push(turn.text);
      continue;
    }
    if (turn.speaker === "bot" && prompts.length > 0) {
      // A bot turn after a menu prompt is the agent working the menu.
      steps.push(turn.text);
    }
  }

  if (prompts.length === 0) return null;

  return {
    subjectId: input.subjectId,
    callId: input.callId,
    steps,
    prompts,
    reachedHumanAtSeconds,
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
   * Deliberately short: it competes for the same 255 characters as the goal,
   * and it is declared `"high"` priority rather than `"required"` so it is the
   * first thing dropped when the goal needs the room.
   */
  public hintFor(subjectId: string): string | null {
    const entry = this.routes.get(subjectId);
    if (!entry || entry.steps.length === 0) return null;
    return `Last time the menu path was: ${entry.steps.join(" then ")}`;
  }

  /**
   * Seconds of hold this route has cost, summed across every cached route.
   *
   * This is the number the product exists to move: time a machine spent in a
   * queue instead of a person.
   */
  public totalHoldSeconds(): number {
    let total = 0;
    for (const entry of this.routes.values()) {
      if (entry.reachedHumanAtSeconds !== null) total += entry.reachedHumanAtSeconds;
    }
    return total;
  }

  public get size(): number {
    return this.routes.size;
  }
}
