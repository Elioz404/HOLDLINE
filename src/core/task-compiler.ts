/**
 * Task compilation.
 *
 * The CALL-E Developer API caps `task` at 255 characters. That is a small
 * budget for an instruction that has to carry a goal, a routing hint for the
 * phone menu, a reference number, and the exact question to ask — and every
 * character spent on politeness is a character not spent on the ask.
 *
 * So the task is not a template string. It is compiled: segments are declared
 * with a priority, and the lowest-priority segments are dropped until the
 * result fits. If the required segments alone do not fit, compilation fails
 * rather than silently truncating mid-sentence and shipping a call that asks
 * half a question.
 */

export const TASK_MAX_CHARS = 255;

export type SegmentPriority = "required" | "high" | "low";

export interface TaskSegment {
  /** Short name used in the compile report and in tests. */
  readonly label: string;
  readonly text: string;
  readonly priority: SegmentPriority;
}

export interface CompiledTask {
  readonly task: string;
  readonly used: number;
  readonly budget: number;
  /** Labels dropped to make the task fit, in the order they were dropped. */
  readonly dropped: readonly string[];
}

export class TaskTooLongError extends Error {
  constructor(
    public readonly used: number,
    public readonly budget: number,
  ) {
    super(
      `Required task segments occupy ${used} characters, over the ${budget}-character limit. ` +
        "Shorten the goal or move detail into the result schema field names.",
    );
    this.name = "TaskTooLongError";
  }
}

const ORDER: Record<SegmentPriority, number> = { required: 0, high: 1, low: 2 };

const join = (segments: readonly TaskSegment[]): string =>
  segments
    .map((s) => s.text.trim())
    .filter((t) => t.length > 0)
    .join(" ");

/**
 * Compile segments into a task string that fits the budget.
 *
 * Segment order in the output follows the order given, not the priority —
 * priority only decides what gets dropped. Dropping starts with the
 * lowest-priority segment and, among equals, the one declared last.
 */
export function compileTask(
  segments: readonly TaskSegment[],
  budget: number = TASK_MAX_CHARS,
): CompiledTask {
  const kept = [...segments];
  const dropped: string[] = [];

  // Droppable segments, worst first: lowest priority, then latest declared.
  const droppable = segments
    .map((segment, index) => ({ segment, index }))
    .filter(({ segment }) => segment.priority !== "required")
    .sort((a, b) => {
      const byPriority = ORDER[b.segment.priority] - ORDER[a.segment.priority];
      return byPriority !== 0 ? byPriority : b.index - a.index;
    });

  for (const { segment } of droppable) {
    if (join(kept).length <= budget) break;
    const at = kept.indexOf(segment);
    if (at >= 0) {
      kept.splice(at, 1);
      dropped.push(segment.label);
    }
  }

  const task = join(kept);
  if (task.length > budget) throw new TaskTooLongError(task.length, budget);

  return { task, used: task.length, budget, dropped };
}
