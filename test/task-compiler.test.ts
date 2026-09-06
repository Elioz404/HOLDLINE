import { describe, expect, it } from "vitest";
import {
  TASK_MAX_CHARS,
  TaskTooLongError,
  compileTask,
  type TaskSegment,
} from "../src/core/task-compiler.js";

const seg = (label: string, text: string, priority: TaskSegment["priority"]): TaskSegment => ({
  label,
  text,
  priority,
});

describe("compileTask", () => {
  it("keeps everything when it fits", () => {
    const result = compileTask([
      seg("goal", "Call the clinic and ask whether they accept new patients.", "required"),
      seg("politeness", "Be brief and polite.", "low"),
    ]);

    expect(result.dropped).toEqual([]);
    expect(result.task).toContain("Be brief and polite.");
    expect(result.used).toBeLessThanOrEqual(TASK_MAX_CHARS);
  });

  it("drops the lowest priority first", () => {
    const long = "x".repeat(200);
    const result = compileTask([
      seg("goal", long, "required"),
      seg("context", "y".repeat(40), "high"),
      seg("politeness", "z".repeat(40), "low"),
    ]);

    expect(result.dropped).toEqual(["politeness"]);
    expect(result.used).toBeLessThanOrEqual(TASK_MAX_CHARS);
  });

  it("drops later segments before earlier ones at equal priority", () => {
    const result = compileTask([
      seg("goal", "x".repeat(200), "required"),
      seg("first", "y".repeat(30), "low"),
      seg("second", "z".repeat(30), "low"),
    ]);

    expect(result.dropped).toEqual(["second"]);
    expect(result.task).toContain("y".repeat(30));
  });

  it("preserves declaration order in the output, not priority order", () => {
    const result = compileTask([
      seg("hint", "Ask for the billing department.", "high"),
      seg("goal", "Get the status of claim 88431.", "required"),
    ]);

    expect(result.task).toBe("Ask for the billing department. Get the status of claim 88431.");
  });

  it("fails rather than truncating a required instruction mid-sentence", () => {
    // Silent truncation is how a call goes out asking half a question.
    expect(() => compileTask([seg("goal", "x".repeat(300), "required")])).toThrow(TaskTooLongError);
  });

  it("respects the documented 255-character API limit by default", () => {
    expect(TASK_MAX_CHARS).toBe(255);
    const result = compileTask([seg("goal", "x".repeat(255), "required")]);
    expect(result.used).toBe(255);
  });
});
