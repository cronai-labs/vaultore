import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	approveNote,
	legacyApprovalsPath,
	noteScheduleState,
	openSchedules,
	revokeNote,
	schedulesPath,
	schedulesStore,
} from "./schedules";
import type { VaultSchedules } from "./schedules";
import { VaultStateStoreError } from "./vault-state-store";

/** One approval per note on this computer, owned by one runner (#301). */

let dir: string;
let path: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "vaultore-schedules-"));
	path = join(dir, "vaultore", "schedules.json");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const NOTE = { path: "Daily.md", schedule: "0 9 * * *", hash: "h1" };
const empty = (): VaultSchedules => ({ obsidianScheduling: false, notes: Object.create(null) });

describe("where the schedules are kept", () => {
	it("lives beside the run locks and the record", () => {
		expect(schedulesPath("darwin", {}, () => "/Users/me")).toBe("/Users/me/.config/vaultore/schedules.json");
	});

	it("is off with nothing approved for a vault with no entry, and when the file is missing", async () => {
		expect(await schedulesStore({ path }).forVault("/vaults/a")).toEqual({ obsidianScheduling: false, notes: {} });
	});

	it("keeps each vault's entry, and drops one that is off with nothing approved", async () => {
		const store = schedulesStore({ path });
		await store.update("/vaults/a", (entry) => approveNote(entry, NOTE, "agent", new Date("2026-11-26T10:00:00Z")));
		await store.update("/vaults/b", (entry) => {
			entry.obsidianScheduling = true;
		});
		await store.update("/vaults/b", (entry) => {
			entry.obsidianScheduling = false;
		});

		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
			format: "vaultore.schedules",
			version: 1,
			vaults: {
				"/vaults/a": {
					obsidianScheduling: false,
					notes: { "Daily.md": { owner: "agent", schedule: "0 9 * * *", hash: "h1", approvedAt: "2026-11-26T10:00:00.000Z" } },
				},
			},
		});
	});

	it.each([
		["an owner that is no runner", { owner: "cron", schedule: "x", hash: "h", approvedAt: "t" }, "names no runner that owns it"],
		["no hash", { owner: "agent", schedule: "x", approvedAt: "t" }, "is incomplete"],
	])("refuses a file with an approval with %s, naming it", async (_what, approval, why) => {
		mkdirSync(join(dir, "vaultore"));
		writeFileSync(
			path,
			JSON.stringify({ format: "vaultore.schedules", version: 1, vaults: { "/v": { obsidianScheduling: true, notes: { "a.md": approval } } } })
		);
		const read = schedulesStore({ path }).forVault("/v");
		await expect(read).rejects.toThrow(VaultStateStoreError);
		await expect(read).rejects.toThrow(`the approval of a.md in vault /v ${why}`);
	});

	it("reads and keeps a note named __proto__ as an entry like any other", async () => {
		const store = schedulesStore({ path });
		await store.update("/v", (entry) => approveNote(entry, { ...NOTE, path: "__proto__" }, "obsidian"));
		const read = await store.forVault("/v");
		expect(Object.keys(read.notes)).toEqual(["__proto__"]);
		expect(noteScheduleState("obsidian", read, { ...NOTE, path: "constructor" })).toEqual({ state: "not-approved" });
	});
});

describe("whether a runner runs a note", () => {
	function approved(owner: "obsidian" | "agent", obsidianScheduling = true): VaultSchedules {
		const schedules = empty();
		schedules.obsidianScheduling = obsidianScheduling;
		approveNote(schedules, NOTE, owner);
		return schedules;
	}

	it("runs nowhere when nobody approved it", () => {
		expect(noteScheduleState("agent", empty(), NOTE).state).toBe("not-approved");
		expect(noteScheduleState("obsidian", empty(), NOTE).state).toBe("not-approved");
	});

	it("runs only in the runner that owns it; the other sees it delegated", () => {
		expect(noteScheduleState("agent", approved("agent"), NOTE).state).toBe("approved");
		expect(noteScheduleState("obsidian", approved("agent"), NOTE).state).toBe("delegated");
		expect(noteScheduleState("obsidian", approved("obsidian"), NOTE).state).toBe("approved");
		expect(noteScheduleState("agent", approved("obsidian"), NOTE).state).toBe("delegated");
	});

	it("stops the agent when the note's content changed, the schedule included", () => {
		expect(noteScheduleState("agent", approved("agent"), { ...NOTE, hash: "h2" }).state).toBe("changed");
	});

	it("stops the plugin when the schedule changed, not when only a cell did", () => {
		expect(noteScheduleState("obsidian", approved("obsidian"), { ...NOTE, schedule: "0 10 * * *", hash: "h2" }).state).toBe("changed");
		expect(noteScheduleState("obsidian", approved("obsidian"), { ...NOTE, hash: "h2" }).state).toBe("approved");
	});

	it("keeps the plugin's notes from running while Run scheduled workflows is off, not the agent's", () => {
		expect(noteScheduleState("obsidian", approved("obsidian", false), NOTE).state).toBe("off");
		expect(noteScheduleState("agent", approved("agent", false), NOTE).state).toBe("approved");
	});

	it("hands a note over by approving it for the other runner, and revoking takes it from both", () => {
		const schedules = approved("agent");
		approveNote(schedules, NOTE, "obsidian");
		expect(noteScheduleState("obsidian", schedules, NOTE).state).toBe("approved");
		expect(noteScheduleState("agent", schedules, NOTE).state).toBe("delegated");

		expect(revokeNote(schedules, NOTE.path)).toBe(true);
		expect(revokeNote(schedules, NOTE.path)).toBe(false);
		expect(noteScheduleState("agent", schedules, NOTE).state).toBe("not-approved");
	});
});

describe("the agent's approvals of 0.4.x", () => {
	let legacy: string;

	beforeEach(() => {
		legacy = join(dir, "old", "approvals.json");
		mkdirSync(join(dir, "old"));
		writeFileSync(
			legacy,
			JSON.stringify({
				format: "vaultore.schedule-approvals",
				version: 1,
				vaults: { "/v": { "Daily.md": { hash: "h1", schedule: "0 9 * * *", approvedAt: "2026-10-01T00:00:00.000Z" } } },
			})
		);
	});

	it("were kept under $XDG_CONFIG_HOME when absolute, else under $HOME, else in %APPDATA%", () => {
		expect(legacyApprovalsPath({ env: { XDG_CONFIG_HOME: "/x" }, platform: "linux", homedir: "/h" })).toBe("/x/vaultore/approvals.json");
		expect(legacyApprovalsPath({ env: { XDG_CONFIG_HOME: "rel" }, platform: "linux", homedir: "/h" })).toBe("/h/.config/vaultore/approvals.json");
		expect(legacyApprovalsPath({ env: { APPDATA: "C:\\A" }, platform: "win32", homedir: "" })).toBe("C:\\A\\vaultore\\approvals.json");
		expect(legacyApprovalsPath({ env: {}, platform: "win32", homedir: "" })).toBeUndefined();
	});

	it("are copied in once as notes the agent owns, and said so", async () => {
		const told: string[] = [];
		const store = await openSchedules({ path, legacyApprovals: legacy, onImported: (from) => told.push(from) });

		expect(await store.forVault("/v")).toEqual({
			obsidianScheduling: false,
			notes: { "Daily.md": { owner: "agent", hash: "h1", schedule: "0 9 * * *", approvedAt: "2026-10-01T00:00:00.000Z" } },
		});
		expect(told).toEqual([legacy]);
		expect(JSON.parse(readFileSync(path, "utf8")).imported).toEqual([legacy]);
	});

	// Whichever runner opens the file first after the upgrade: an approval
	// given since stays, and a revoke stays revoked.
	it("are copied only once, so a revoke stays revoked, and leave an approval given here alone", async () => {
		const store = schedulesStore({ path });
		await store.update("/v", (entry) => approveNote(entry, { ...NOTE, hash: "mine" }, "obsidian"));
		await openSchedules({ path, legacyApprovals: legacy });
		expect((await store.forVault("/v")).notes["Daily.md"]).toMatchObject({ owner: "obsidian", hash: "mine" });

		await store.update("/v", (entry) => {
			revokeNote(entry, "Daily.md");
		});
		const told: string[] = [];
		await openSchedules({ path, legacyApprovals: legacy, onImported: (from) => told.push(from) });

		expect((await store.forVault("/v")).notes).toEqual({});
		expect(told).toEqual([]);
	});

	it("leave the old file as it is", async () => {
		const before = readFileSync(legacy, "utf8");
		await openSchedules({ path, legacyApprovals: legacy });
		expect(readFileSync(legacy, "utf8")).toBe(before);
	});

	it("create nothing when there are none", async () => {
		await openSchedules({ path, legacyApprovals: join(dir, "none", "approvals.json") });
		expect(() => readFileSync(path)).toThrow();
	});

	it("are refused, naming the file, when that file is not an approvals file", async () => {
		writeFileSync(legacy, "{}");
		await expect(openSchedules({ path, legacyApprovals: legacy })).rejects.toThrow(`Cannot use the approvals file ${legacy}`);
	});
});
