import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	GAP_MARGIN_MS,
	LATE_AFTER_MS,
	MissedSlotError,
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
		expect(gaps.reduce((sum, gap) => sum + gap.count, 0)).toBe((23 * 3600 * 1000 - GAP_MARGIN_MS) / 1000);
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

describe("a claim and a gap", () => {
	it("are one decision: a slot claimed in time is not part of a gap found later", async () => {
		await ran(at("2026-11-24T10:15:00Z"));
		await ran(at("2026-11-24T11:15:00Z"));

		const [gap] = await look(at("2026-11-24T13:20:00Z"));
		expect(gap?.slot).toEqual(at("2026-11-24T12:15:00Z"));
	});
});
