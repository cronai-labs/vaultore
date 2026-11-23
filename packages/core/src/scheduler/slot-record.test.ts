import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { noteKey } from "../lock/run-lock";
import {
	MIN_KEEP_MS,
	SlotTakenError,
	claimSlot,
	keepMilliseconds,
	pruneSlotRecord,
	readSlotRecord,
	slotFromName,
	slotName,
	slotRecordDirectory,
} from "./slot-record";

const DAY = 24 * 60 * 60 * 1000;

let dir: string;
let vaultRoot: string;
let slots: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "vaultore-slots-"));
	vaultRoot = join(dir, "Vault");
	slots = join(dir, "slots");
	mkdirSync(join(vaultRoot, "Notes"), { recursive: true });
	writeFileSync(join(vaultRoot, "Notes", "Daily.md"), "---\nore: true\n---\n");
	writeFileSync(join(vaultRoot, "Notes", "Other.md"), "---\nore: true\n---\n");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const SLOT = new Date("2026-11-24T10:15:00.000Z");

function claim(by: string, options: { slot?: Date; notePath?: string; keepDays?: number; now?: Date } = {}) {
	return claimSlot({
		vaultRoot,
		notePath: options.notePath ?? "Notes/Daily.md",
		schedule: "15 * * * *",
		slot: options.slot ?? SLOT,
		by,
		directory: slots,
		keepDays: options.keepDays,
		now: options.now ?? new Date(SLOT.getTime() + 60_000),
	});
}

/** A claim written by another process, as it would be on disk. */
async function foreignClaim(pid: number, slot: Date, since = new Date().toISOString()) {
	const noteDir = join(slots, await noteKey(vaultRoot, "Notes/Daily.md"));
	mkdirSync(noteDir, { recursive: true });
	writeFileSync(
		join(noteDir, `${slotName(slot)}.claim.json`),
		JSON.stringify({
			version: 1,
			vault: realpathSync(vaultRoot),
			note: "Notes/Daily.md",
			schedule: "15 * * * *",
			slot: slot.toISOString(),
			pid,
			host: hostname(),
			since,
			by: "vaultore agent",
		})
	);
	return noteDir;
}

describe("slotRecordDirectory", () => {
	it("is beside the run locks, under the account's home directory", () => {
		expect(slotRecordDirectory("darwin", { HOME: "/somewhere/else" })).toBe(
			join(userInfo().homedir, ".config", "vaultore", "slots")
		);
		expect(slotRecordDirectory("win32", { APPDATA: "C:\\R" })).toBe(join("C:\\R", "vaultore", "slots"));
		expect(() => slotRecordDirectory("win32", {})).toThrow("where its schedule record belong");
	});
});

describe("slot names", () => {
	it("name the instant in UTC, and read back", () => {
		expect(slotName(SLOT)).toBe("20261124T101500000Z");
		expect(slotFromName("20261124T101500000Z")).toEqual(SLOT);
		expect(slotFromName("20261124T101500000Z.claim")).toBeUndefined();
		expect(slotFromName("20261399T101500000Z")).toBeUndefined();
	});
});

describe("claimSlot", () => {
	it("claims an open slot, and refuses a second runner, naming the first", async () => {
		await claim("Obsidian");

		const second = claim("vaultore agent");
		await expect(second).rejects.toBeInstanceOf(SlotTakenError);
		await expect(second).rejects.toThrow(
			`The 2026-11-24T10:15:00.000Z run of Notes/Daily.md was claimed by process ${process.pid} (Obsidian)`
		);
	});

	it("lets exactly one of many concurrent claims through", async () => {
		const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => claim(`runner ${i}`)));

		expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
		const refused = results.filter((r) => r.status === "rejected");
		expect(refused).toHaveLength(11);
		for (const r of refused) expect((r as PromiseRejectedResult).reason).toBeInstanceOf(SlotTakenError);
	});

	it("keeps slots of other times and other notes apart", async () => {
		await claim("Obsidian");
		await claim("vaultore agent", { slot: new Date(SLOT.getTime() + 3_600_000) });
		await claim("vaultore agent", { notePath: "Notes/Other.md" });

		expect(await readSlotRecord({ directory: slots })).toHaveLength(3);
	});

	it("leaves no temporary file behind, whether it got the slot or not", async () => {
		await claim("Obsidian");
		await expect(claim("vaultore agent")).rejects.toThrow(SlotTakenError);

		const noteDir = join(slots, await noteKey(vaultRoot, "Notes/Daily.md"));
		expect(readdirSync(noteDir)).toEqual([`${slotName(SLOT)}.claim.json`]);
	});
});

describe("the outcome", () => {
	it("is written once, by the claimer; a second finish changes nothing", async () => {
		const claimed = await claim("Obsidian");
		await claimed.finish({ result: "completed", runId: "run-1" });
		await claimed.finish({ result: "failed", reason: "late" });

		const [entry] = await readSlotRecord({ directory: slots });
		expect(entry).toMatchObject({ state: "completed", runId: "run-1", note: "Notes/Daily.md", schedule: "15 * * * *" });
		expect(entry?.claimedBy.by).toBe("Obsidian");
		expect(entry?.reason).toBeUndefined();
	});

	it("keeps the reason of a skipped run", async () => {
		const claimed = await claim("vaultore agent");
		await claimed.finish({ result: "skipped", reason: "Notes/Daily.md is already being run by process 1 (vaultore run)" });

		expect((await readSlotRecord({ directory: slots }))[0]).toMatchObject({
			state: "skipped",
			reason: "Notes/Daily.md is already being run by process 1 (vaultore run)",
		});
	});
});

describe("readSlotRecord", () => {
	it("shows a claim with no outcome as running while its claimer lives", async () => {
		await claim("Obsidian");
		await foreignClaim(4242, new Date(SLOT.getTime() + 3_600_000));

		const states = (await readSlotRecord({ directory: slots, isAlive: () => true })).map((e) => e.state);
		expect(states).toEqual(["running", "running"]);
	});

	// The plugin runs in one process: a second claim of the slot that loses
	// must not unmark the first, which would then read as left behind.
	it("keeps a claim of this process running when a second claim of its slot loses", async () => {
		const first = await claim("Obsidian");
		await expect(claim("Obsidian")).rejects.toThrow(SlotTakenError);

		expect((await readSlotRecord({ directory: slots }))[0]?.state).toBe("running");
		await first.finish({ result: "completed" });
		expect((await readSlotRecord({ directory: slots }))[0]?.state).toBe("completed");
	});

	it("shows it as abandoned once its claimer is gone, and says why", async () => {
		await foreignClaim(4242, SLOT);

		const [entry] = await readSlotRecord({ directory: slots, isAlive: () => false });
		expect(entry).toMatchObject({ state: "abandoned", reason: "the runner is no longer running" });
	});

	it("reads only one vault's or one note's slots when asked", async () => {
		await claim("Obsidian");
		await claim("Obsidian", { notePath: "Notes/Other.md" });
		const elsewhere = join(dir, "Elsewhere");
		mkdirSync(elsewhere);

		expect(await readSlotRecord({ directory: slots, vaultRoot })).toHaveLength(2);
		expect(await readSlotRecord({ directory: slots, vaultRoot: elsewhere })).toHaveLength(0);
		expect((await readSlotRecord({ directory: slots, notePath: "Notes/Other.md" })).map((e) => e.note)).toEqual([
			"Notes/Other.md",
		]);
	});

	it("reads an empty record before anything was claimed", async () => {
		expect(await readSlotRecord({ directory: slots })).toEqual([]);
	});
});

describe("pruning", () => {
	it("keeps 30 days at most, and a setting can shorten it, but never below a day", () => {
		expect(keepMilliseconds()).toBe(30 * DAY);
		expect(keepMilliseconds(365)).toBe(30 * DAY);
		expect(keepMilliseconds(7)).toBe(7 * DAY);
		expect(keepMilliseconds(0)).toBe(MIN_KEEP_MS);
		expect(keepMilliseconds(-3)).toBe(MIN_KEEP_MS);
		expect(keepMilliseconds(Number.NaN)).toBe(30 * DAY);
	});

	it("removes finished slots older than the history kept, and keeps the younger ones", async () => {
		const old = await claim("Obsidian", { slot: new Date(SLOT.getTime() - 8 * DAY) });
		await old.finish({ result: "completed" });
		const recent = await claim("Obsidian", { slot: new Date(SLOT.getTime() - 2 * DAY) });
		await recent.finish({ result: "completed" });

		expect(await pruneSlotRecord({ directory: slots, keepDays: 7, now: SLOT })).toBe(1);
		expect((await readSlotRecord({ directory: slots })).map((e) => e.slot)).toEqual([
			new Date(SLOT.getTime() - 2 * DAY),
		]);
	});

	it("with the history off, keeps a slot for a day, then removes it", async () => {
		const hours = (h: number) => new Date(SLOT.getTime() - h * 3_600_000);
		await (await claim("Obsidian", { slot: hours(23) })).finish({ result: "completed" });
		await (await claim("Obsidian", { slot: hours(25) })).finish({ result: "completed" });

		await pruneSlotRecord({ directory: slots, keepDays: 0, now: SLOT });
		expect((await readSlotRecord({ directory: slots })).map((e) => e.slot)).toEqual([hours(23)]);
	});

	it("keeps an old claim whose run may go on, and removes an abandoned one", async () => {
		await foreignClaim(4242, new Date(SLOT.getTime() - 40 * DAY));

		await pruneSlotRecord({ directory: slots, now: SLOT, isAlive: () => true });
		expect(await readSlotRecord({ directory: slots, isAlive: () => true })).toHaveLength(1);

		await pruneSlotRecord({ directory: slots, now: SLOT, isAlive: () => false });
		expect(await readSlotRecord({ directory: slots })).toHaveLength(0);
		expect(existsSync(slots) && readdirSync(slots)).toEqual([]);
	});

	it("removes a temporary file a killed writer left, once it is old", async () => {
		const noteDir = await foreignClaim(4242, SLOT);
		const stray = join(noteDir, `${slotName(SLOT)}.outcome.json.99.abcdef.tmp`);
		writeFileSync(stray, "{");
		const longAgo = new Date(SLOT.getTime() - 31 * DAY);
		utimesSync(stray, longAgo, longAgo);

		await pruneSlotRecord({ directory: slots, now: SLOT, isAlive: () => true });
		expect(existsSync(stray)).toBe(false);
	});

	it("is done by every claim, with the claimer's setting", async () => {
		await (await claim("Obsidian", { slot: new Date(SLOT.getTime() - 3 * DAY) })).finish({ result: "completed" });

		await claim("vaultore agent", { keepDays: 1, now: SLOT });
		expect((await readSlotRecord({ directory: slots })).map((e) => e.slot)).toEqual([SLOT]);
	});
});
