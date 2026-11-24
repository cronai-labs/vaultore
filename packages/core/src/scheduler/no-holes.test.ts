import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nodeTimers } from "../testing/timers";
import { WorkflowScheduler, lateAfterMs } from "./index";
import type { DueWorkflow } from "./index";
import { SlotTakenError, claimSlot, isLateSlot, readSlotRecord, recordMissedSlots } from "./slot-record";

/**
 * Every occurrence is decided (#269): a runner that arms a note, or wakes,
 * either fires an occurrence in time (a claim) or records it as missed (a
 * gap); none falls between the two. Each test plays a host as the plugin and
 * the agent do: arm, look for missed runs, tick at once, and on each tick
 * claim a slot in time or record a late one as missed.
 */

const NOTE = "Notes/Daily.md";
let dir: string;
let vaultRoot: string;
let slots: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "vaultore-no-holes-"));
	vaultRoot = join(dir, "Vault");
	slots = join(dir, "slots");
	mkdirSync(join(vaultRoot, "Notes"), { recursive: true });
	writeFileSync(join(vaultRoot, NOTE), "---\nore: true\n---\n");
	vi.useFakeTimers({ toFake: ["Date"] });
});

afterEach(() => {
	vi.useRealTimers();
	rmSync(dir, { recursive: true, force: true });
});

const at = (iso: string) => new Date(iso);

/** A runner as the hosts are, on one record, with its late threshold. */
function host(by: string, late = lateAfterMs()) {
	const handled: Promise<unknown>[] = [];
	const scheduler = new WorkflowScheduler({
		timers: nodeTimers,
		lateAfterMs: late,
		onTick: (due) => {
			for (const workflow of due) handled.push(handle(workflow));
		},
	});
	const look = (workflow: { path: string; cronExpression: string; armedAt: Date }) =>
		recordMissedSlots({ vaultRoot, notePath: workflow.path, schedule: workflow.cronExpression, by, directory: slots, armedAt: workflow.armedAt, lateAfterMs: late });
	const handle = async (workflow: DueWorkflow): Promise<void> => {
		if (isLateSlot(workflow.slot, new Date(), late)) {
			await look(workflow);
			return;
		}
		if (workflow.superseded) {
			try {
				const claim = await claimSlot({ vaultRoot, notePath: workflow.path, schedule: workflow.cronExpression, slot: workflow.slot, by, directory: slots, pruneIntervalMs: 0 });
				await claim.finish({ result: "skipped", reason: "superseded" });
			} catch (err) {
				if (!(err instanceof SlotTakenError)) throw err;
			}
			return;
		}
		try {
			const claim = await claimSlot({ vaultRoot, notePath: workflow.path, schedule: workflow.cronExpression, slot: workflow.slot, by, directory: slots, pruneIntervalMs: 0 });
			await claim.finish({ result: "completed" });
		} catch (err) {
			if (!(err instanceof SlotTakenError)) throw err;
		}
	};
	return {
		async arm(schedule: string) {
			const entry = scheduler.register(NOTE, schedule);
			await look(entry);
			scheduler.tick();
			await Promise.all(handled.splice(0));
		},
		async tick() {
			scheduler.tick();
			await Promise.all(handled.splice(0));
		},
	};
}

/** The record's decisions: slots claimed, and gaps as [first, last]. */
async function decided() {
	vi.useRealTimers();
	const entries = await readSlotRecord({ directory: slots });
	vi.useFakeTimers({ toFake: ["Date"] });
	return {
		claimed: entries.filter((e) => e.kind === "claimed").map((e) => e.slot.toISOString()),
		gaps: entries.filter((e) => e.kind === "missed").map((e) => [e.slot.toISOString(), e.until?.toISOString(), e.count]),
	};
}

describe("arming", () => {
	// A laptop opened at 09:01 must not lose its 09:00 run.
	it("fires an occurrence of the last two minutes in time", async () => {
		// Cron reads 09:00 in the runner's time zone, so the times are local.
		const daily = "0 9 * * *";
		const local = (day: number, h: number, m: number, sec = 0) => new Date(2026, 10, day, h, m, sec);
		vi.setSystemTime(local(23, 9, 0, 30));
		await host("Obsidian").arm(daily);
		vi.setSystemTime(local(24, 9, 1));

		await host("Obsidian").arm(daily);

		expect(await decided()).toEqual({
			claimed: [local(23, 9, 0).toISOString(), local(24, 9, 0).toISOString()],
			gaps: [],
		});
	});

	it("records what is older as missed, from the last decided slot", async () => {
		const hourly = "15 * * * *";
		vi.setSystemTime(at("2026-11-24T10:15:10Z"));
		await host("Obsidian").arm(hourly);
		vi.setSystemTime(at("2026-11-24T15:16:00Z"));

		await host("Obsidian").arm(hourly);

		expect(await decided()).toEqual({
			claimed: ["2026-11-24T10:15:00.000Z", "2026-11-24T15:15:00.000Z"],
			gaps: [["2026-11-24T11:15:00.000Z", "2026-11-24T14:15:00.000Z", 4]],
		});
	});

	it("backfills nothing for a note with no record, and nothing of another schedule", async () => {
		vi.setSystemTime(at("2026-11-24T10:15:10Z"));
		await host("Obsidian").arm("0 3 * * *");
		vi.setSystemTime(at("2026-11-24T15:16:00Z"));

		// Changed from daily at 03:00 to hourly: the hours before were never scheduled.
		await host("Obsidian").arm("15 * * * *");

		expect(await decided()).toEqual({ claimed: ["2026-11-24T15:15:00.000Z"], gaps: [] });
	});
});

describe("a late tick", () => {
	it("records what it slept through as missed, and fires the last two minutes in time", async () => {
		const hourly = "15 * * * *";
		vi.setSystemTime(at("2026-11-24T10:15:10Z"));
		const runner = host("vaultore agent");
		await runner.arm(hourly);

		vi.setSystemTime(at("2026-11-24T15:16:30Z"));
		await runner.tick();

		expect(await decided()).toEqual({
			claimed: ["2026-11-24T10:15:00.000Z", "2026-11-24T15:15:00.000Z"],
			gaps: [["2026-11-24T11:15:00.000Z", "2026-11-24T14:15:00.000Z", 4]],
		});
	});

	it("records its slot as missed also for a note with no record yet", async () => {
		const hourly = "15 * * * *";
		vi.setSystemTime(at("2026-11-24T10:20:00Z"));
		const runner = host("vaultore agent");
		await runner.arm(hourly);

		vi.setSystemTime(at("2026-11-24T13:40:00Z"));
		await runner.tick();

		expect(await decided()).toEqual({
			claimed: [],
			gaps: [["2026-11-24T11:15:00.000Z", "2026-11-24T13:15:00.000Z", 3]],
		});
	});
});

describe("two runners", () => {
	it("armed at different moments name and claim each slot once", async () => {
		const minutely = "* * * * *";
		const plugin = host("Obsidian");
		const agent = host("vaultore agent");

		vi.setSystemTime(at("2026-11-24T10:14:03.123Z"));
		await plugin.arm(minutely);
		vi.setSystemTime(at("2026-11-24T10:14:47.987Z"));
		await agent.arm(minutely);
		vi.setSystemTime(at("2026-11-24T10:15:00.412Z"));
		await plugin.tick();
		vi.setSystemTime(at("2026-11-24T10:15:38.020Z"));
		await agent.tick();

		const { claimed, gaps } = await decided();
		expect(claimed).toEqual(["2026-11-24T10:13:00.000Z", "2026-11-24T10:14:00.000Z", "2026-11-24T10:15:00.000Z"]);
		expect(gaps).toEqual([]);
	});
});

describe("the late threshold, a runner's setting", () => {
	it("is 2 to 60 minutes; 2 by default", () => {
		expect(lateAfterMs()).toBe(2 * 60_000);
		expect(lateAfterMs(10)).toBe(10 * 60_000);
		expect(lateAfterMs(1)).toBe(2 * 60_000);
		expect(lateAfterMs(600)).toBe(60 * 60_000);
	});

	// A runner set to ten minutes still runs a slot five minutes late, and
	// records as missed only what is older than ten.
	it("set longer, fires a slot five minutes late, and misses only what is older", async () => {
		const hourly = "15 * * * *";
		vi.setSystemTime(at("2026-11-24T10:15:10Z"));
		const runner = host("Obsidian", lateAfterMs(10));
		await runner.arm(hourly);

		vi.setSystemTime(at("2026-11-24T15:20:00Z"));
		await runner.tick();

		expect(await decided()).toEqual({
			claimed: ["2026-11-24T10:15:00.000Z", "2026-11-24T15:15:00.000Z"],
			gaps: [["2026-11-24T11:15:00.000Z", "2026-11-24T14:15:00.000Z", 4]],
		});
	});
});
