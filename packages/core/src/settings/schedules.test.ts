import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as nodeSetTimeout } from "node:timers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireLock } from "../lock";
import {
	ApprovalAnswerError,
	approveNote,
	approvedPermissions,
	catchUpRefusal,
	coveredPermissions,
	legacyApprovalsPath,
	noteScheduleState,
	openSchedules,
	reviewApproval,
	revokeNote,
	schedulesPath,
	schedulesStore,
	scheduledSince,
	setObsidianScheduling,
} from "./schedules";
import type { ApprovedPermissions, NotePermissions, ScheduledNoteNow, VaultSchedules } from "./schedules";
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

const DEFAULTS: NotePermissions = { network: "deny", buildNetwork: "deny", vaultRead: "allow", vaultWrite: "deny" };
const NOTE: ScheduledNoteNow = { path: "Daily.md", schedule: "0 9 * * *", hash: "h1", permissions: DEFAULTS };
const empty = (): VaultSchedules => ({ obsidianScheduling: false, obsidianBinding: "strict", notes: Object.create(null) });
/** The permissions a first approval of `note` holds, with `answers` for its asks. */
const first = (note: ScheduledNoteNow = NOTE, answers = {}): ApprovedPermissions => approvedPermissions(reviewApproval(undefined, note), answers);
const HELD = {
	network: { value: "deny", source: "frontmatter" },
	buildNetwork: { value: "deny", source: "frontmatter" },
	vaultRead: { value: "allow", source: "frontmatter" },
	vaultWrite: { value: "deny", source: "frontmatter" },
};

describe("where the schedules are kept", () => {
	it("lives beside the run locks and the record", () => {
		expect(schedulesPath("darwin", {}, () => "/Users/me")).toBe("/Users/me/.config/vaultore/schedules.json");
	});

	it("is off with nothing approved for a vault with no entry, and when the file is missing", async () => {
		expect(await schedulesStore({ path }).forVault("/vaults/a")).toEqual({ obsidianScheduling: false, obsidianBinding: "strict", notes: {} });
	});

	it("keeps each vault's entry, and drops one that is off with nothing approved", async () => {
		const store = schedulesStore({ path });
		await store.update("/vaults/a", (entry) => approveNote(entry, NOTE, "agent", first(), new Date("2026-11-26T10:00:00Z")));
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
					obsidianBinding: "strict",
					notes: {
						"Daily.md": { owner: "agent", schedule: "0 9 * * *", hash: "h1", approvedAt: "2026-11-26T10:00:00.000Z", permissions: HELD },
					},
				},
			},
		});
	});

	it.each([
		["an owner that is no runner", { owner: "cron", schedule: "x", hash: "h", approvedAt: "t" }, "names no runner that owns it"],
		["no hash", { owner: "agent", schedule: "x", approvedAt: "t" }, "is incomplete"],
		[
			"a permission that is neither allowed nor denied",
			{ owner: "agent", schedule: "x", hash: "h", approvedAt: "t", permissions: { ...HELD, network: { value: "ask", source: "answer" } } },
			"holds no valid network permission",
		],
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

	// A click in Obsidian and a vaultore command at the same moment (#291).
	it("waits a moment for another change instead of refusing", async () => {
		const timers = { setTimeout: (callback: () => void, ms: number) => nodeSetTimeout(callback, ms) };
		mkdirSync(join(dir, "vaultore"));
		const release = await acquireLock(`${path}.lock`);
		nodeSetTimeout(() => void release(), 150);

		await schedulesStore({ path, wait: { timers, ms: 2000, stepMs: 20 } }).update("/v", (entry) => approveNote(entry, NOTE, "agent", first()));

		expect((await schedulesStore({ path }).forVault("/v")).notes["Daily.md"]?.owner).toBe("agent");
	});

	it("reads and keeps a note named __proto__ as an entry like any other", async () => {
		const store = schedulesStore({ path });
		await store.update("/v", (entry) => approveNote(entry, { ...NOTE, path: "__proto__" }, "obsidian", first()));
		const read = await store.forVault("/v");
		expect(Object.keys(read.notes)).toEqual(["__proto__"]);
		expect(noteScheduleState("obsidian", read, { ...NOTE, path: "constructor" })).toEqual({ state: "not-approved" });
	});
});

describe("whether a runner runs a note", () => {
	function approved(owner: "obsidian" | "agent", obsidianScheduling = true, note: ScheduledNoteNow = NOTE, answers = {}): VaultSchedules {
		const schedules = empty();
		schedules.obsidianScheduling = obsidianScheduling;
		approveNote(schedules, note, owner, first(note, answers));
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

	it("stops the plugin when the content changed, under strict binding, the default", () => {
		expect(noteScheduleState("obsidian", approved("obsidian"), { ...NOTE, hash: "h2" }).state).toBe("changed");
	});

	it("stops the plugin under narrow binding only when the schedule or a permission changed, not a cell", () => {
		const schedules = approved("obsidian");
		schedules.obsidianBinding = "narrow";
		expect(noteScheduleState("obsidian", schedules, { ...NOTE, hash: "h2" }).state).toBe("approved");
		expect(noteScheduleState("obsidian", schedules, { ...NOTE, schedule: "0 10 * * *" }).state).toBe("changed");
		expect(noteScheduleState("obsidian", schedules, { ...NOTE, hash: "h2", permissions: { ...DEFAULTS, network: "allow" } }).state).toBe("changed");
	});

	it("keeps the agent strict, whatever the plugin's binding", () => {
		const schedules = approved("agent");
		schedules.obsidianBinding = "narrow";
		expect(noteScheduleState("agent", schedules, { ...NOTE, hash: "h2" }).state).toBe("changed");
	});

	it("lets a note whose cells changed run again when switched to narrow, and stops it when switched back", () => {
		const schedules = approved("obsidian");
		const edited = { ...NOTE, hash: "h2" };
		expect(noteScheduleState("obsidian", schedules, edited).state).toBe("changed");
		schedules.obsidianBinding = "narrow";
		expect(noteScheduleState("obsidian", schedules, edited).state).toBe("approved");
		schedules.obsidianBinding = "strict";
		expect(noteScheduleState("obsidian", schedules, edited).state).toBe("changed");
	});

	it("keeps the plugin's notes from running while Run scheduled workflows is off, not the agent's", () => {
		expect(noteScheduleState("obsidian", approved("obsidian", false), NOTE).state).toBe("off");
		expect(noteScheduleState("agent", approved("agent", false), NOTE).state).toBe("approved");
	});

	it("hands a note over by approving it for the other runner, and revoking takes it from both", () => {
		const schedules = approved("agent");
		approveNote(schedules, NOTE, "obsidian", first());
		expect(noteScheduleState("obsidian", schedules, NOTE).state).toBe("approved");
		expect(noteScheduleState("agent", schedules, NOTE).state).toBe("delegated");

		expect(revokeNote(schedules, NOTE.path)).toBe(true);
		expect(revokeNote(schedules, NOTE.path)).toBe(false);
		expect(noteScheduleState("agent", schedules, NOTE).state).toBe("not-approved");
	});
});

describe("a catch-up follows the owner's scheduling (#307)", () => {
	const approval = (owner: "obsidian" | "agent") => ({ owner, schedule: "0 9 * * *", hash: "h", approvedAt: "2026-11-26T00:00:00.000Z" });
	const schedules = (on: boolean): VaultSchedules => ({ obsidianScheduling: on, obsidianBinding: "strict", notes: {} });

	it("refuses a note Obsidian runs while Run scheduled workflows is off", () => {
		expect(catchUpRefusal(schedules(false), approval("obsidian"))).toMatch(/Run scheduled workflows is off/);
	});

	it("allows it while the switch is on", () => {
		expect(catchUpRefusal(schedules(true), approval("obsidian"))).toBeUndefined();
	});

	it("allows a note the agent runs, whatever the switch, as it stays scheduled while the agent is stopped", () => {
		expect(catchUpRefusal(schedules(false), approval("agent"))).toBeUndefined();
	});
});

describe("since when a note is scheduled (#308)", () => {
	const approvedAt = "2026-11-20T08:00:00.000Z";
	const withNote = (owner: "obsidian" | "agent"): VaultSchedules => ({
		obsidianScheduling: false,
		obsidianBinding: "strict",
		notes: { "a.md": { owner, schedule: "0 9 * * *", hash: "h", approvedAt } },
	});

	it("notes when Run scheduled workflows is turned on, and only then", () => {
		const schedules = withNote("obsidian");
		setObsidianScheduling(schedules, true, new Date("2026-11-22T12:00:00.000Z"));
		setObsidianScheduling(schedules, true, new Date("2026-11-23T12:00:00.000Z"));
		expect(schedules.obsidianSchedulingSince).toBe("2026-11-22T12:00:00.000Z");

		setObsidianScheduling(schedules, false);
		expect(schedules).not.toHaveProperty("obsidianSchedulingSince");
	});

	it("is the later of the approval and the switch turned on, for a note Obsidian runs", () => {
		const schedules = withNote("obsidian");
		expect(scheduledSince(schedules, "a.md")).toBeUndefined();
		setObsidianScheduling(schedules, true, new Date("2026-11-22T12:00:00.000Z"));
		expect(scheduledSince(schedules, "a.md")).toEqual(new Date("2026-11-22T12:00:00.000Z"));
		schedules.obsidianSchedulingSince = "2026-11-01T00:00:00.000Z";
		expect(scheduledSince(schedules, "a.md")).toEqual(new Date(approvedAt));
	});

	it("is the approval for a note the agent runs, whatever the switch", () => {
		expect(scheduledSince(withNote("agent"), "a.md")).toEqual(new Date(approvedAt));
	});

	it("is nothing for a note with no approval", () => {
		expect(scheduledSince(withNote("agent"), "b.md")).toBeUndefined();
	});

	it("is kept in the file, and refused when it is no time", async () => {
		const store = schedulesStore({ path: join(dir, "schedules.json") });
		await store.update("/v", (entry) => setObsidianScheduling(entry, true, new Date("2026-11-22T12:00:00.000Z")));
		expect((await store.forVault("/v")).obsidianSchedulingSince).toBe("2026-11-22T12:00:00.000Z");

		writeFileSync(
			join(dir, "schedules.json"),
			JSON.stringify({ format: "vaultore.schedules", version: 1, vaults: { "/v": { obsidianScheduling: true, obsidianSchedulingSince: "soon", notes: {} } } })
		);
		await expect(store.forVault("/v")).rejects.toThrow(/no valid time for when scheduling was turned on/);
	});
});

describe("approving again asks only about what changed (#299)", () => {
	const ASKS: ScheduledNoteNow = { ...NOTE, permissions: { ...DEFAULTS, network: "ask" } };
	const statuses = (review: ReturnType<typeof reviewApproval>) => Object.fromEntries(review.permissions.map((p) => [p.key, p.status]));
	const approval = (note: ScheduledNoteNow, answers = {}) => {
		const schedules = empty();
		approveNote(schedules, note, "agent", first(note, answers));
		return schedules.notes[note.path];
	};

	it("shows every permission as new on a first approval, and an ask as needing an answer", () => {
		const review = reviewApproval(undefined, ASKS);
		expect(statuses(review)).toEqual({ network: "needs-answer", buildNetwork: "new", vaultRead: "new", vaultWrite: "new" });
		expect(review.needsAnswer).toEqual(["network"]);
	});

	it("keeps everything when only a cell changed: one action approves again, nothing asked", () => {
		const review = reviewApproval(approval(ASKS, { network: "allow" }), { ...ASKS, hash: "h2" });
		expect(review.changed).toBe(false);
		expect(review.needsAnswer).toEqual([]);
		expect(approvedPermissions(review).network).toEqual({ value: "allow", source: "answer" });
	});

	it("shows a frontmatter change as changed, and asks nothing for it", () => {
		const review = reviewApproval(approval(NOTE), { ...NOTE, hash: "h2", permissions: { ...DEFAULTS, network: "allow" } });
		expect(statuses(review)).toMatchObject({ network: "changed", vaultRead: "kept" });
		expect(review.needsAnswer).toEqual([]);
		expect(approvedPermissions(review).network).toEqual({ value: "allow", source: "frontmatter" });
	});

	it("asks only for a permission newly at ask, also one that was allowed by the frontmatter", () => {
		const before = approval({ ...NOTE, permissions: { ...DEFAULTS, network: "allow" } });
		const review = reviewApproval(before, { ...ASKS, hash: "h2" });
		expect(statuses(review)).toEqual({ network: "needs-answer", buildNetwork: "kept", vaultRead: "kept", vaultWrite: "kept" });
	});

	it("shows an answer the frontmatter now decides as dropped", () => {
		const review = reviewApproval(approval(ASKS, { network: "allow" }), { ...NOTE, hash: "h2" });
		expect(statuses(review)).toMatchObject({ network: "answer-dropped" });
		expect(approvedPermissions(review).network).toEqual({ value: "deny", source: "frontmatter" });
	});

	it("refuses an ask left unanswered, and an answer where the frontmatter decides, naming them", () => {
		expect(() => approvedPermissions(reviewApproval(undefined, ASKS))).toThrow(ApprovalAnswerError);
		expect(() => approvedPermissions(reviewApproval(undefined, ASKS))).toThrow("network needs an answer");
		expect(() => approvedPermissions(reviewApproval(undefined, ASKS), { network: "deny", vaultWrite: "allow" })).toThrow(
			"vaultWrite is set by the frontmatter, not asked"
		);
	});

	it("lets an answer replace one kept from before", () => {
		const review = reviewApproval(approval(ASKS, { network: "allow" }), ASKS);
		expect(approvedPermissions(review, { network: "deny" }).network).toEqual({ value: "deny", source: "answer" });
	});

	it("carries answers over to the other runner on a handover, under its binding", () => {
		const schedules = empty();
		schedules.obsidianScheduling = true;
		approveNote(schedules, ASKS, "agent", first(ASKS, { network: "allow" }));
		const review = reviewApproval(schedules.notes[ASKS.path], ASKS);
		approveNote(schedules, ASKS, "obsidian", approvedPermissions(review));
		expect(noteScheduleState("obsidian", schedules, ASKS).state).toBe("approved");
		expect(schedules.notes[ASKS.path]?.permissions?.network).toEqual({ value: "allow", source: "answer" });
	});

	it("does not cover a note whose ask was not answered at approval, nor one whose frontmatter value changed", () => {
		const held = approval(NOTE);
		expect(coveredPermissions(held as never, ASKS)).toBeUndefined();
		expect(coveredPermissions(held as never, { ...NOTE, permissions: { ...DEFAULTS, vaultRead: "deny" } })).toBeUndefined();
		expect(coveredPermissions(held as never, NOTE)?.vaultRead).toEqual({ value: "allow", source: "frontmatter" });
	});

	it("keeps a vault entry that holds only the narrow binding", async () => {
		const store = schedulesStore({ path });
		await store.update("/v", (entry) => {
			entry.obsidianBinding = "narrow";
		});
		expect((await store.forVault("/v")).obsidianBinding).toBe("narrow");
	});

	it("refuses a binding it does not know, naming it", async () => {
		mkdirSync(join(dir, "vaultore"));
		writeFileSync(path, JSON.stringify({ format: "vaultore.schedules", version: 1, vaults: { "/v": { obsidianScheduling: true, obsidianBinding: "loose", notes: {} } } }));
		await expect(schedulesStore({ path }).forVault("/v")).rejects.toThrow("names no binding VaultOre knows");
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
			obsidianBinding: "strict",
			notes: { "Daily.md": { owner: "agent", hash: "h1", schedule: "0 9 * * *", approvedAt: "2026-10-01T00:00:00.000Z" } },
		});
		expect(told).toEqual([legacy]);
		// Recorded beside the file, with what was copied (#309).
		const marker = JSON.parse(readFileSync(`${path}.imports.json`, "utf8"));
		expect(marker).toMatchObject({ format: "vaultore.imports", version: 1, imports: [{ from: legacy, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }] });
		expect(JSON.parse(readFileSync(path, "utf8"))).not.toHaveProperty("imported");
	});

	// #309: the file's own error says to remove it; that must not undo a revoke.
	it("are not copied in again when schedules.json is removed", async () => {
		await openSchedules({ path, legacyApprovals: legacy });
		const store = schedulesStore({ path });
		await store.update("/v", (entry) => {
			revokeNote(entry, "Daily.md");
		});
		rmSync(path);

		await openSchedules({ path, legacyApprovals: legacy });

		expect((await store.forVault("/v")).notes).toEqual({});
	});

	it("are not copied again when the old file changed since, and that is said once per change", async () => {
		await openSchedules({ path, legacyApprovals: legacy });
		writeFileSync(legacy, readFileSync(legacy, "utf8").replace("h1", "h2"));
		const changed: string[] = [];

		await openSchedules({ path, legacyApprovals: legacy, onLegacyChanged: (from) => changed.push(from) });
		await openSchedules({ path, legacyApprovals: legacy, onLegacyChanged: (from) => changed.push(from) });

		expect(changed).toEqual([legacy]);
		expect((await schedulesStore({ path }).forVault("/v")).notes["Daily.md"]?.hash).toBe("h1");
	});

	it("are not copied when schedules.json says so the earlier way, and the marker is written", async () => {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify({ format: "vaultore.schedules", version: 1, vaults: {}, imported: [legacy] }));
		const told: string[] = [];

		await openSchedules({ path, legacyApprovals: legacy, onImported: (from) => told.push(from) });

		expect(told).toEqual([]);
		expect((await schedulesStore({ path }).forVault("/v")).notes).toEqual({});
		expect(JSON.parse(readFileSync(`${path}.imports.json`, "utf8")).imports[0].from).toBe(legacy);
	});

	it("refuses a marker it cannot read, and copies nothing", async () => {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(`${path}.imports.json`, "{broken");

		await expect(openSchedules({ path, legacyApprovals: legacy })).rejects.toThrow(/imports\.json, which records what was copied/);
	});

	// Whichever runner opens the file first after the upgrade: an approval
	// given since stays, and a revoke stays revoked.
	it("are copied only once, so a revoke stays revoked, and leave an approval given here alone", async () => {
		const store = schedulesStore({ path });
		await store.update("/v", (entry) => approveNote(entry, { ...NOTE, hash: "mine" }, "obsidian", first()));
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

	// They hold no permissions: those were the frontmatter's when approved.
	it("run a note with no ask as approved, and ask to review one with an ask", async () => {
		const store = await openSchedules({ path, legacyApprovals: legacy });
		const schedules = await store.forVault("/v");
		expect(noteScheduleState("agent", schedules, NOTE).state).toBe("approved");
		const asks = { ...NOTE, permissions: { ...DEFAULTS, network: "ask" as const } };
		const state = noteScheduleState("agent", schedules, asks);
		expect(state.state).toBe("changed");
		expect(state.state === "changed" && state.review.needsAnswer).toEqual(["network"]);
		expect(state.state === "changed" && state.review.permissions.find((p) => p.key === "vaultRead")?.status).toBe("kept");
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
