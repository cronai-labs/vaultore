import { describe, expect, it } from "vitest";
import { WorkflowScheduler } from "./index";

describe("WorkflowScheduler", () => {
  it("registers workflows and ticks when due", () => {
    const scheduler = new WorkflowScheduler();
    const entry = scheduler.register("Workflows/test.md", "* * * * *");

    entry.nextRun = new Date(Date.now() - 1000);
    const due = scheduler.tick();

    expect(due).toHaveLength(1);
    expect(due[0]?.path).toBe("Workflows/test.md");
    expect(entry.lastRun).toBeInstanceOf(Date);
    expect(entry.nextRun.getTime()).toBeGreaterThan(Date.now() - 1000);
  });
});
