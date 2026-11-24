import { describe, expect, it } from "vitest";
import { nodeTimers } from "../testing/timers";
import type { Timers } from "../types";
import { WorkflowScheduler, computeNextRun } from "./index";

describe("WorkflowScheduler", () => {
  it("registers workflows and ticks when due", () => {
    const scheduler = new WorkflowScheduler({ timers: nodeTimers });
    const entry = scheduler.register("Workflows/test.md", "* * * * *");

    entry.nextRun = new Date(Date.now() - 1000);
    const due = scheduler.tick();

    expect(due).toHaveLength(1);
    expect(due[0]?.path).toBe("Workflows/test.md");
    expect(entry.lastRun).toBeInstanceOf(Date);
    expect(entry.nextRun.getTime()).toBeGreaterThan(Date.now() - 1000);
  });

  // Hosts re-register on every vault change. Recomputing nextRun from "now"
  // pushed a due run to the following occurrence, so a busy vault could keep
  // an hourly schedule from ever firing (#46).
  it("keeps nextRun and lastRun when re-registered with the same cron", () => {
    const scheduler = new WorkflowScheduler({ timers: nodeTimers });
    const entry = scheduler.register("Workflows/test.md", "0 * * * *");
    const due = new Date(Date.now() - 1000);
    entry.nextRun = due;
    entry.lastRun = new Date(Date.now() - 3_600_000);
    const lastRun = entry.lastRun;

    const again = scheduler.register("Workflows/test.md", "0 * * * *");

    expect(again.nextRun).toBe(due);
    expect(again.lastRun).toBe(lastRun);
    expect(scheduler.tick().map((w) => w.path)).toEqual(["Workflows/test.md"]);
  });

  // The slot names the scheduled run in the schedule record (#255): the
  // occurrence that came due, not the time of the tick.
  it("hands over the occurrence that came due as the slot", () => {
    const scheduler = new WorkflowScheduler({ timers: nodeTimers });
    const entry = scheduler.register("Workflows/test.md", "* * * * *");
    const occurrence = new Date(Date.now() - 1000);
    entry.nextRun = occurrence;

    const [due] = scheduler.tick();

    expect(due?.slot).toBe(occurrence);
    expect(entry.nextRun.getTime()).toBeGreaterThan(occurrence.getTime());
  });

  // The agent's rescan unregistered everything and registered it again, which
  // recomputed every next run from now: a slot due before the next tick was
  // dropped (#255).
  it("keeps a due slot when the armed notes are replaced", () => {
    const scheduler = new WorkflowScheduler({ timers: nodeTimers });
    const due = new Date(Date.now() - 1000);
    scheduler.register("Workflows/a.md", "* * * * *").nextRun = due;
    scheduler.register("Workflows/gone.md", "* * * * *");

    const { invalid, armed } = scheduler.replace([
      { path: "Workflows/a.md", cronExpression: "* * * * *" },
      { path: "Workflows/new.md", cronExpression: "0 * * * *" },
      { path: "Workflows/typo.md", cronExpression: "not a cron" },
    ]);

    expect(invalid.map((entry) => entry.path)).toEqual(["Workflows/typo.md"]);
    // Newly armed: the host looks for its missed runs (#269).
    expect(armed.map((entry) => entry.path)).toEqual(["Workflows/new.md"]);
    expect(scheduler.list().map((entry) => entry.path).sort()).toEqual(["Workflows/a.md", "Workflows/new.md"]);
    expect(scheduler.tick().map((entry) => [entry.path, entry.slot])).toEqual([["Workflows/a.md", due]]);
  });

  it("drops a note whose schedule became invalid when the armed notes are replaced", () => {
    const scheduler = new WorkflowScheduler({ timers: nodeTimers });
    scheduler.register("Workflows/a.md", "* * * * *");

    expect(scheduler.replace([{ path: "Workflows/a.md", cronExpression: "nope" }]).invalid).toHaveLength(1);
    expect(scheduler.list()).toEqual([]);
  });

  it("recomputes nextRun when the cron changes", () => {
    const scheduler = new WorkflowScheduler({ timers: nodeTimers });
    const entry = scheduler.register("Workflows/test.md", "0 * * * *");
    entry.nextRun = new Date(Date.now() - 1000);

    const changed = scheduler.register("Workflows/test.md", "0 9 * * *");

    expect(changed.cronExpression).toBe("0 9 * * *");
    expect(changed.nextRun.getTime()).toBeGreaterThan(Date.now());
  });

  // The plugin ties the interval to its lifecycle through the timers it
  // passes; the scheduler must use those, never a global timer.
  it("starts and stops its tick through the timers it was given", () => {
    const calls: string[] = [];
    let tick: (() => void) | undefined;
    const timers: Timers = {
      setTimeout: () => 0,
      clearTimeout: () => undefined,
      setInterval: (callback, ms) => {
        calls.push(`setInterval ${ms}`);
        tick = callback;
        return 42;
      },
      clearInterval: (handle) => {
        calls.push(`clearInterval ${String(handle)}`);
      },
    };
    const ticked: string[][] = [];
    const scheduler = new WorkflowScheduler({
      timers,
      tickIntervalMs: 5_000,
      onTick: (workflows) => ticked.push(workflows.map((w) => w.path)),
    });
    scheduler.register("Workflows/test.md", "* * * * *").nextRun = new Date(Date.now() - 1000);

    scheduler.start();
    scheduler.start();
    tick?.();
    scheduler.stop();
    scheduler.stop();

    expect(calls).toEqual(["setInterval 5000", "clearInterval 42"]);
    expect(ticked).toEqual([["Workflows/test.md"]]);
  });

  it("rejects an invalid cron without touching the existing entry", () => {
    const scheduler = new WorkflowScheduler({ timers: nodeTimers });
    scheduler.register("Workflows/test.md", "0 * * * *");

    expect(() => scheduler.register("Workflows/test.md", "not a cron")).toThrow();
    expect(scheduler.list().map((w) => w.cronExpression)).toEqual(["0 * * * *"]);
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
