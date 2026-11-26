import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	GAP_MARGIN_MS,
	LATE_AFTER_MS,
	MissedSlotError,
	SlotTakenError,
	catchUpMissedSlot,
	claimSlot,
	dismissMissedSlots,
	isLateSlot,
	occurrencesBetween,
	pruneSlotRecord,
	readSlotRecord,
	recordMissedSlots,
} from "./slot-record";

/**
 * Missed slots (#269): gaps found after a note's last decided slot, recorded
 * once, shown, and resolved once by a dismissal or a catch-up. The model:
 * specs/schedule-record-spec.md.
 */

const DAY = 24 * 60 * 60 * 1000;
const HOURLY = "15 * * * *";
const NOTE = "Notes/Daily.md";
const at = (iso: string) => new Date(iso);

let dir: string;
let vaultRoot: string;
let slots: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "vaultore-missed-"));
	vaultRoot = join(dir, "Vault");
	slots = join(dir, "slots");
	mkdirSync(join(vaultRoot, "Notes"), { recursive: true });
	writeFileSync(join(vaultRoot, NOTE), "---\nore: true\n---\n");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

async function ran(slot: Date) {
	const claim = await claimSlot({ vaultRoot, notePath: NOTE, schedule: HOURLY, slot, by: "Obsidian", directory: slots, pruneIntervalMs: 0, now: slot });
	await claim.finish({ result: "completed" });
}

function look(now: Date, options: { keepDays?: number; schedule?: string; by?: string } = {}) {
	return recordMissedSlots({
		vaultRoot,
		notePath: NOTE,
		schedule: options.schedule ?? HOURLY,
		by: options.by ?? "vaultore agent",
		directory: slots,
		now,
		...(options.keepDays !== undefined ? { keepDays: options.keepDays } : {}),
	});
}

const resolveOptions = (slot?: Date) => ({ vaultRoot, notePath: NOTE, by: "vaultore", directory: slots, ...(slot ? { slot } : {}) });

describe("finding gaps", () => {
	it("records nothing for a note with no decided slot: nothing is backfilled", async () => {
		expect(await look(at("2026-11-24T15:20:00Z"))).toEqual([]);
		expect(await readSlotRecord({ directory: slots })).toEqual([]);
	});

	it("records the slots after the last decided one as one gap, up to the margin", async () => {
		await ran(at("2026-11-24T10:15:00Z"));

		const [gap] = await look(at("2026-11-24T15:20:00Z"));

		expect(gap).toEqual({ slot: at("2026-11-24T11:15:00Z"), until: at("2026-11-24T15:15:00Z"), count: 5 });
		const entry = (await readSlotRecord({ directory: slots })).find((e) => e.kind === "missed");
		expect(entry).toMatchObject({ state: "missed", count: 5, until: at("2026-11-24T15:15:00Z") });
		expect(entry?.claimedBy.by).toBe("vaultore agent");
	});

	it("leaves out a slot a runner may still claim in time", async () => {
		await ran(at("2026-11-24T10:15:00Z"));

		// 11:15 is two minutes and a second old: a tick could still claim it.
		const now = new Date(at("2026-11-24T11:15:00Z").getTime() + GAP_MARGIN_MS - 1000);
		expect(await look(now)).toEqual([]);
	});

	it("records a gap once; looking again finds it decided", async () => {
		await ran(at("2026-11-24T10:15:00Z"));
		await look(at("2026-11-24T15:20:00Z"));

		expect(await look(at("2026-11-24T15:20:00Z"))).toEqual([]);
		expect(await readSlotRecord({ directory: slots })).toHaveLength(2);
	});

	it("looks after the last gap next time", async () => {
		await ran(at("2026-11-24T10:15:00Z"));
		await look(at("2026-11-24T12:20:00Z"));

		const [next] = await look(at("2026-11-24T15:20:00Z"));
		expect(next).toEqual({ slot: at("2026-11-24T13:15:00Z"), until: at("2026-11-24T15:15:00Z"), count: 3 });
	});

	// A late tick claims its in-time slot while it looks for gaps; the claim
	// landing first must not hide the slots before it.
	it("records the slots before an in-time claim that landed first", async () => {
		await ran(at("2026-11-24T10:15:00Z"));
		await ran(at("2026-11-24T15:15:00Z"));

		const [gap] = await look(at("2026-11-24T15:16:00Z"));

		expect(gap).toEqual({ slot: at("2026-11-24T11:15:00Z"), until: at("2026-11-24T14:15:00Z"), count: 4 });
	});

	it("records one gap when two runners look at once", async () => {
		await ran(at("2026-11-24T10:15:00Z"));

		const found = await Promise.all([look(at("2026-11-24T15:20:00Z"), { by: "Obsidian" }), look(at("2026-11-24T15:20:00Z"))]);

		expect(found.flat()).toHaveLength(1);
		expect((await readSlotRecord({ directory: slots })).filter((e) => e.kind === "missed")).toHaveLength(1);
	});

	it("does not look further back than the history kept", async () => {
		await ran(at("2026-11-19T10:15:00Z"));

		const [gap] = await look(at("2026-11-24T15:20:00Z"), { keepDays: 1 });
		expect(gap?.slot).toEqual(at("2026-11-23T16:15:00Z"));
		expect(gap?.count).toBe(24);
	});

	it("splits a very long run of missed slots into several gaps", async () => {
		const every = "* * * * * *";
		await (await claimSlot({ vaultRoot, notePath: NOTE, schedule: every, slot: at("2026-11-24T00:00:00Z"), by: "Obsidian", directory: slots, pruneIntervalMs: 0, now: at("2026-11-24T00:00:00Z") })).finish({ result: "completed" });

		const gaps = await look(at("2026-11-24T23:00:00Z"), { schedule: every });
		expect(gaps.length).toBeGreaterThan(1);
		// Every second after 00:00:00 that is strictly older than the margin.
		expect(gaps.reduce((sum, gap) => sum + gap.count, 0)).toBe((23 * 3600 * 1000 - GAP_MARGIN_MS) / 1000 - 1);
	});
});

describe("late ticks", () => {
	it("are late past two minutes", () => {
		const slot = at("2026-11-24T10:15:00Z");
		expect(isLateSlot(slot, new Date(slot.getTime() + LATE_AFTER_MS))).toBe(false);
		expect(isLateSlot(slot, new Date(slot.getTime() + LATE_AFTER_MS + 1))).toBe(true);
	});

	it("list a schedule's occurrences after one instant up to another", () => {
		expect(occurrencesBetween(HOURLY, at("2026-11-24T10:15:00Z"), at("2026-11-24T12:15:00Z"))).toEqual([
			at("2026-11-24T11:15:00Z"),
			at("2026-11-24T12:15:00Z"),
		]);
	});
});

describe("a gap", () => {
	beforeEach(async () => {
		await ran(at("2026-11-24T10:15:00Z"));
		await look(at("2026-11-24T15:20:00Z"));
	});

	it("is dismissed once; a second dismissal and a catch-up are refused", async () => {
		const [dismissed] = await dismissMissedSlots(resolveOptions());
		expect(dismissed?.slot).toEqual(at("2026-11-24T11:15:00Z"));

		const entry = (await readSlotRecord({ directory: slots })).find((e) => e.kind === "missed");
		expect(entry).toMatchObject({ state: "dismissed" });
		expect(entry?.resolvedBy?.by).toBe("vaultore");

		await expect(dismissMissedSlots(resolveOptions())).rejects.toThrow("has no missed runs to dismiss");
		await expect(catchUpMissedSlot(resolveOptions(at("2026-11-24T11:15:00Z")))).rejects.toThrow(
			/were dismissed already by process \d+ \(vaultore\), so they cannot be caught up/
		);
	});

	it("is caught up once, running until its outcome is written", async () => {
		const claim = await catchUpMissedSlot(resolveOptions());
		expect(claim.gap.count).toBe(5);

		expect((await readSlotRecord({ directory: slots })).find((e) => e.kind === "missed")?.state).toBe("running");
		await expect(catchUpMissedSlot(resolveOptions())).rejects.toThrow(MissedSlotError);
		await expect(dismissMissedSlots(resolveOptions(claim.slot))).rejects.toThrow("were caught up already");

		await claim.finish({ result: "completed", runId: "r9" });
		expect((await readSlotRecord({ directory: slots })).find((e) => e.kind === "missed")).toMatchObject({
			state: "completed",
			runId: "r9",
		});
	});

	it("is named by its first slot when the note has several", async () => {
		await look(at("2026-11-24T20:20:00Z"));

		await expect(catchUpMissedSlot(resolveOptions())).rejects.toThrow(
			"has 2 missed runs; name the one to catch up by its first slot: 2026-11-24T11:15:00.000Z, 2026-11-24T16:15:00.000Z"
		);
		const claim = await catchUpMissedSlot(resolveOptions(at("2026-11-24T16:15:00Z")));
		expect(claim.gap.count).toBe(5);
		await expect(catchUpMissedSlot(resolveOptions(at("2026-11-24T13:15:00Z")))).rejects.toThrow(
			"has no missed runs from 2026-11-24T13:15:00.000Z"
		);
	});

	it("dismisses all the note's open gaps when none is named", async () => {
		await look(at("2026-11-24T20:20:00Z"));

		expect(await dismissMissedSlots(resolveOptions())).toHaveLength(2);
	});

	it("is pruned with its resolution once older than the history, unless its catch-up runs", async () => {
		const claim = await catchUpMissedSlot(resolveOptions());
		await pruneSlotRecord({ directory: slots, now: new Date(at("2026-11-24T11:15:00Z").getTime() + 31 * DAY) });
		expect((await readSlotRecord({ directory: slots })).filter((e) => e.kind === "missed")).toHaveLength(1);

		await claim.finish({ result: "completed" });
		await pruneSlotRecord({ directory: slots, now: new Date(at("2026-11-24T11:15:00Z").getTime() + 31 * DAY) });
		expect(await readSlotRecord({ directory: slots })).toEqual([]);
	});
});

// #308: the record keeps what a later look needs, within the history kept.
describe("what the record keeps", () => {
	const DAILY = "0 9 * * *";
	const ranDaily = async (slot: Date) => {
		const claim = await claimSlot({ vaultRoot, notePath: NOTE, schedule: DAILY, slot, by: "vaultore agent", directory: slots, pruneIntervalMs: 0, now: slot });
		await claim.finish({ result: "completed" });
	};
	const lookDaily = (now: Date, options: { keepDays?: number; scheduledSince?: Date; armedAt?: Date } = {}) =>
		recordMissedSlots({ vaultRoot, notePath: NOTE, schedule: DAILY, by: "vaultore agent", directory: slots, now, ...options });
	const open = async () => (await readSlotRecord({ directory: slots })).filter((e) => e.kind === "missed" && e.state === "missed");

	it("keeps an open gap that began before the history kept, while its last slot is inside it", async () => {
		await ran(at("2026-11-20T10:15:00Z"));
		const now = at("2026-11-21T09:30:00Z");
		const [gap] = await look(now, { keepDays: 1 });
		expect(gap).toBeDefined();

		await pruneSlotRecord({ directory: slots, keepDays: 1, now: new Date(now.getTime() + 2 * 3_600_000) });

		expect((await open()).map((e) => e.slot)).toEqual([gap!.slot]);
	});

	it("prunes a gap once its last slot is older than the history kept", async () => {
		await ran(at("2026-11-20T10:15:00Z"));
		const now = at("2026-11-21T09:30:00Z");
		await look(now, { keepDays: 1 });

		await pruneSlotRecord({ directory: slots, keepDays: 1, now: new Date(now.getTime() + 2 * DAY) });

		expect(await readSlotRecord({ directory: slots })).toEqual([]);
	});

	it("finds the runs missed since the note was scheduled, when its last decision was pruned", async () => {
		await ranDaily(at("2026-11-21T09:00:00Z"));
		await pruneSlotRecord({ directory: slots, keepDays: 1, now: at("2026-11-23T09:30:00Z") });
		expect(await readSlotRecord({ directory: slots })).toEqual([]);

		const now = at("2026-11-24T10:00:00Z");
		const gaps = await lookDaily(now, { keepDays: 1, scheduledSince: at("2026-11-20T08:00:00Z"), armedAt: now });

		// Within the day kept: the 24th's occurrence (cron runs in local time).
		const expected = occurrencesBetween(DAILY, at("2026-11-23T10:00:00Z"), at("2026-11-24T10:00:00Z"));
		expect(expected).toHaveLength(1);
		expect(gaps.map((g) => [g.slot.toISOString(), g.count])).toEqual([[expected[0]!.toISOString(), 1]]);
	});

	it("records no run from before the note was scheduled, though an older decision is kept", async () => {
		await ranDaily(at("2026-11-21T09:00:00Z"));

		// Scheduling turned on again at noon on the 23rd: the 22nd and 23rd were not scheduled.
		const gaps = await lookDaily(at("2026-11-24T10:00:00Z"), { scheduledSince: at("2026-11-23T12:00:00Z") });

		const expected = occurrencesBetween(DAILY, at("2026-11-23T12:00:00Z"), at("2026-11-24T10:00:00Z"));
		expect(expected).toHaveLength(1);
		expect(gaps.map((g) => [g.slot.toISOString(), g.count])).toEqual([[expected[0]!.toISOString(), 1]]);
	});

	// #328: 0.4.x kept no record, so an approval it gave says nothing about which runs ran.
	it("records no gap for an approval of 0.4.x on its first look after the upgrade", async () => {
		const { scheduledSince } = await import("../settings/schedules");
		const now = at("2026-11-24T15:20:00Z");
		const since = scheduledSince(
			{ obsidianScheduling: false, obsidianBinding: "strict", notes: { [NOTE]: { owner: "agent", schedule: HOURLY, hash: "h", approvedAt: "2026-10-01T00:00:00.000Z" } } },
			NOTE
		);

		const gaps = await recordMissedSlots({
			vaultRoot, notePath: NOTE, schedule: HOURLY, by: "vaultore agent", directory: slots, now, armedAt: now,
			...(since ? { scheduledSince: since } : {}),
		});

		expect(gaps).toEqual([]);
	});

	it("dismisses the gaps of a note deleted since", async () => {
		await ran(at("2026-11-24T10:15:00Z"));
		await look(at("2026-11-24T15:20:00Z"));
		unlinkSync(join(vaultRoot, NOTE));

		const dismissed = await dismissMissedSlots(resolveOptions());

		expect(dismissed).toHaveLength(1);
		expect(await open()).toEqual([]);
	});
});

describe("a claim and a gap", () => {
	// A runner with a longer late threshold, or an older version, could claim
	// a slot the other recorded as missed; it would run, and be caught up too.
	it("are one decision also inside a gap: a slot the gap holds cannot be claimed", async () => {
		await ran(at("2026-11-24T10:15:00Z"));
		await look(at("2026-11-24T15:20:00Z"));

		const claim = claimSlot({ vaultRoot, notePath: NOTE, schedule: HOURLY, slot: at("2026-11-24T13:15:00Z"), by: "Obsidian", directory: slots, pruneIntervalMs: 0 });
		await expect(claim).rejects.toThrow(SlotTakenError);
		await expect(
			claimSlot({ vaultRoot, notePath: NOTE, schedule: HOURLY, slot: at("2026-11-24T15:15:00Z"), by: "Obsidian", directory: slots, pruneIntervalMs: 0 })
		).rejects.toThrow(
			/The 2026-11-24T15:15:00.000Z run of Notes\/Daily.md is one of 5 missed runs from 2026-11-24T11:15:00.000Z to 2026-11-24T15:15:00.000Z, recorded by process \d+ \(vaultore agent\)/
		);
		// After the gap, a slot is claimed as ever.
		await ran(at("2026-11-24T16:15:00Z"));
	});

	it("are one decision: a slot claimed in time is not part of a gap found later", async () => {
		await ran(at("2026-11-24T10:15:00Z"));
		await ran(at("2026-11-24T11:15:00Z"));

		const [gap] = await look(at("2026-11-24T13:20:00Z"));
		expect(gap?.slot).toEqual(at("2026-11-24T12:15:00Z"));
	});
});
