import { describe, expect, it } from "vitest";
import { WorkflowScheduler, computeNextRun } from "./index";

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

// computeNextRun is the only cron-parser call site, so its API surface is what
// a major bump breaks — cron-parser 5 replaced the default export's
// parseExpression() with CronExpressionParser.parse().
//
// Cron fields are interpreted in the host's LOCAL timezone, so these assert on
// local components rather than an absolute instant; asserting ISO strings would
// make the suite pass only in UTC.
describe("computeNextRun", () => {
	const base = new Date(2026, 7, 19, 10, 15, 0); // Wed 19 Aug 2026, 10:15 local

	it("computes the next occurrence of a daily schedule", () => {
		const next = computeNextRun("0 18 * * *", base);
		expect(next.getDate()).toBe(19);
		expect(next.getHours()).toBe(18);
		expect(next.getMinutes()).toBe(0);
	});

	it("rolls into the following day when the time has passed", () => {
		const next = computeNextRun("0 9 * * *", base);
		expect(next.getDate()).toBe(20);
		expect(next.getHours()).toBe(9);
	});

	it("honours day-of-week ranges", () => {
		// The 19th is a Wednesday, so the next weekday 09:00 is Thursday the 20th.
		const next = computeNextRun("0 9 * * 1-5", base);
		expect(next.getDay()).toBe(4);
		expect(next.getDate()).toBe(20);
	});

	it("skips the weekend on a weekday-only schedule", () => {
		const friday = new Date(2026, 7, 21, 12, 0, 0);
		const next = computeNextRun("0 9 * * 1-5", friday);
		expect(next.getDay()).toBe(1); // Monday
		expect(next.getDate()).toBe(24);
	});

	it("advances on every-minute schedules", () => {
		expect(computeNextRun("* * * * *", base).getMinutes()).toBe(16);
	});

	it("throws on an invalid expression rather than returning a bogus date", () => {
		expect(() => computeNextRun("not a cron", base)).toThrow();
	});
});
