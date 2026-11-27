import { describe, expect, it } from "vitest";
import { VaultStateStoreError } from "@vaultore/core";
import {
	createApprovedRunner,
	createGuardedRescan,
	createSingleFlightRunner,
	createSkipReporter,
	planRegistrations,
} from "./agent";
import type { ScheduledNote } from "./schedules";
import type { NoteApproval, UnattendedApproval, VaultSchedules } from "@vaultore/core";

/**
 * `vaultore agent` fires a workflow on every scheduler tick. A run that takes
 * longer than the interval used to get a second, concurrent run of the same
 * note, both writing outputs back into it (#27).
 */

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

describe("createSingleFlightRunner", () => {
	it("skips a workflow that is still running and reports the skip", async () => {
		const gate = deferred();
		const started: string[] = [];
		const skipped: string[] = [];
		const run = createSingleFlightRunner(
			async (path) => {
				started.push(path);
				await gate.promise;
			},
			(path) => skipped.push(path)
		);

		const first = run("a.md");
		await run("a.md");

		expect(started).toEqual(["a.md"]);
		expect(skipped).toEqual(["a.md"]);

		gate.resolve();
		await first;
	});

	// The scheduled slot rides along to the run (#255).
	it("passes the run its argument", async () => {
		const seen: Array<[string, number]> = [];
		const run = createSingleFlightRunner<number>(async (path, slot) => {
			seen.push([path, slot]);
		}, () => undefined);

		await run("a.md", 7);

		expect(seen).toEqual([["a.md", 7]]);
	});

	it("runs different workflows concurrently", async () => {
		const gate = deferred();
		const started: string[] = [];
		const run = createSingleFlightRunner(
			async (path) => {
				started.push(path);
				await gate.promise;
			},
			() => undefined
		);

		const both = Promise.all([run("a.md"), run("b.md")]);
		expect(started).toEqual(["a.md", "b.md"]);
		gate.resolve();
		await both;
	});

	it("runs the workflow again once the previous run finished, also after a failure", async () => {
		let calls = 0;
		const run = createSingleFlightRunner(
			async () => {
				calls += 1;
				if (calls === 1) throw new Error("boom");
			},
			() => undefined
		);

		await expect(run("a.md")).rejects.toThrow("boom");
		await run("a.md");

		expect(calls).toBe(2);
	});
});

/**
 * `vaultore agent` used to run every scheduled note it found, including notes
 * that arrived later through sync (#116). It now runs a note only while an
 * approval for that path matches the note's content.
 */

const DEFAULTS = { network: "deny", buildNetwork: "deny", vaultRead: "allow", vaultWrite: "deny" } as const;
const scheduled = (path: string, hash: string, schedule = "0 9 * * *", permissions: ScheduledNote["permissions"] = DEFAULTS): ScheduledNote => ({
	path,
	schedule,
	hash,
	permissions,
});
const fromFrontmatter = (value: "allow" | "deny") => ({ value, source: "frontmatter" as const });
const approval = (hash: string, owner: "agent" | "obsidian" = "agent"): NoteApproval => ({
	owner,
	hash,
	schedule: "0 9 * * *",
	approvedAt: "2026-11-09T00:00:00.000Z",
	permissions: {
		network: fromFrontmatter("deny"),
		buildNetwork: fromFrontmatter("deny"),
		vaultRead: fromFrontmatter("allow"),
		vaultWrite: fromFrontmatter("deny"),
	},
});
const schedules = (notes: Record<string, NoteApproval>, obsidianScheduling = false): VaultSchedules => ({
	obsidianScheduling,
	obsidianBinding: "strict",
	notes,
});

describe("planRegistrations", () => {
	it("registers approved notes and skips the others with the reason", () => {
		const plan = planRegistrations(
			[scheduled("ok.md", "h1"), scheduled("new.md", "h2"), scheduled("edited.md", "h4")],
			schedules({ "ok.md": approval("h1"), "edited.md": approval("h3") })
		);

		expect(plan.register.map((note) => note.path)).toEqual(["ok.md"]);
		expect(plan.skipped).toEqual([
			{ path: "new.md", reason: "it is not approved" },
			{ path: "edited.md", reason: "it changed since it was approved; approve it again: vaultore schedules approve edited.md" },
		]);
	});

	// #299: the command to run is the one that answers what changed.
	it("names a permission newly at ask, and how to answer it", () => {
		const plan = planRegistrations(
			[scheduled("a.md", "h2", "0 9 * * *", { ...DEFAULTS, network: "ask" })],
			schedules({ "a.md": approval("h1") })
		);

		expect(plan.skipped[0]?.reason).toBe(
			"it changed since it was approved; network now asks: approve it with an answer, vaultore schedules approve a.md --allow network (or --deny network)"
		);
	});

	it("names a permission whose frontmatter value changed", () => {
		const plan = planRegistrations(
			[scheduled("a.md", "h2", "0 9 * * *", { ...DEFAULTS, vaultWrite: "allow" })],
			schedules({ "a.md": approval("h1") })
		);

		expect(plan.skipped[0]?.reason).toBe("it changed since it was approved; vaultWrite is now allow; approve it again: vaultore schedules approve a.md");
	});

	it("registers nothing without approvals", () => {
		const plan = planRegistrations([scheduled("a.md", "h1")], schedules({}));

		expect(plan.register).toEqual([]);
		expect(plan.skipped).toEqual([{ path: "a.md", reason: "it is not approved" }]);
	});

	// Obsidian's to run (#301): left out, and nothing said about it.
	it("leaves out notes handed to Obsidian, without a reason to report", () => {
		const plan = planRegistrations([scheduled("a.md", "h1")], schedules({ "a.md": approval("h1", "obsidian") }, true));

		expect(plan.register).toEqual([]);
		expect(plan.skipped).toEqual([]);
		expect(plan.delegated.map((note) => note.path)).toEqual(["a.md"]);
	});
});

describe("createApprovedRunner", () => {
	function setup(options: {
		note?: () => Promise<{ note: ScheduledNote; content: string }>;
		schedules?: () => Promise<VaultSchedules>;
	}) {
		const ran: Array<[string, string]> = [];
		const approvals: UnattendedApproval[] = [];
		const refused: Array<[string, string]> = [];
		const run = createApprovedRunner({
			readNote:
				options.note ??
				(async () => ({ note: scheduled("a.md", "h1"), content: "the content checked" })),
			schedules: options.schedules ?? (async () => schedules({ "a.md": approval("h1") })),
			run: async (path, content, _arg, unattended) => {
				ran.push([path, content]);
				approvals.push(unattended);
			},
			onRefuse: (path, reason) => refused.push([path, reason]),
		});
		return { run, ran, refused, approvals };
	}

	it("runs an approved note with the content it checked, and the approval it checked it against", async () => {
		const { run, ran, refused, approvals } = setup({});

		await run("a.md");

		expect(ran).toEqual([["a.md", "the content checked"]]);
		expect(refused).toEqual([]);
		expect(approvals).toEqual([{ approval: approval("h1"), binding: "content" }]);
	});

	it("does not run a note that changed since the last rescan", async () => {
		const { run, ran, refused } = setup({
			note: async () => ({ note: scheduled("a.md", "h2"), content: "edited" }),
		});

		await run("a.md");

		expect(ran).toEqual([]);
		expect(refused).toEqual([["a.md", "it changed since it was approved; approve it again: vaultore schedules approve a.md"]]);
	});

	it("does not run a note whose approval was revoked since the last rescan", async () => {
		const { run, ran, refused } = setup({ schedules: async () => schedules({}) });

		await run("a.md");

		expect(ran).toEqual([]);
		expect(refused).toEqual([["a.md", "it is not approved"]]);
	});

	it("does not run a note that is gone or no longer a scheduled workflow", async () => {
		const { run, ran, refused } = setup({
			note: async () => {
				throw new Error("it cannot be read");
			},
		});

		await run("a.md");

		expect(ran).toEqual([]);
		expect(refused).toEqual([["a.md", "it cannot be read"]]);
	});

	it("does not run anything while the approvals file cannot be used", async () => {
		const { run, ran, refused } = setup({
			schedules: async () => {
				throw new VaultStateStoreError("Cannot use the schedules file /state/schedules.json");
			},
		});

		await run("a.md");

		expect(ran).toEqual([]);
		expect(refused).toEqual([["a.md", "Cannot use the schedules file /state/schedules.json"]]);
	});

	it("does not run a note handed to Obsidian since the last rescan", async () => {
		const { run, ran, refused } = setup({ schedules: async () => schedules({ "a.md": approval("h1", "obsidian") }, true) });

		await run("a.md");

		expect(ran).toEqual([]);
		expect(refused).toEqual([["a.md", "it is handed to Obsidian"]]);
	});

	it("lets a failing run fail, so the caller reports it as a failed run", async () => {
		const run = createApprovedRunner({
			readNote: async () => ({ note: scheduled("a.md", "h1"), content: "c" }),
			schedules: async () => schedules({ "a.md": approval("h1") }),
			run: async () => {
				throw new Error("engine down");
			},
			onRefuse: () => undefined,
		});

		await expect(run("a.md")).rejects.toThrow("engine down");
	});
});

describe("createSkipReporter", () => {
	const skip = (path: string, reason = "it is not approved") => ({ path, reason });

	it("names each skipped note once, and again only when the set changes", () => {
		const lines: string[] = [];
		const report = createSkipReporter((line) => lines.push(line));

		report({ registered: 1, skipped: [skip("a.md")] });
		expect(lines).toEqual(["not running a.md: it is not approved"]);

		report({ registered: 1, skipped: [skip("a.md")] });
		expect(lines).toHaveLength(1);

		report({ registered: 1, skipped: [skip("a.md"), skip("b.md", "it changed since it was approved")] });
		expect(lines.slice(1)).toEqual([
			"not running a.md: it is not approved",
			"not running b.md: it changed since it was approved",
		]);
	});

	it("reports again when a note's reason changes", () => {
		const lines: string[] = [];
		const report = createSkipReporter((line) => lines.push(line));

		report({ registered: 0, skipped: [skip("a.md")] });
		lines.length = 0;
		report({ registered: 0, skipped: [skip("a.md", "it changed since it was approved")] });

		expect(lines[0]).toBe("not running a.md: it changed since it was approved");
	});

	it("says plainly when nothing is approved, and how to approve", () => {
		const lines: string[] = [];
		const report = createSkipReporter((line) => lines.push(line));

		report({ registered: 0, skipped: [skip("a.md")] });

		expect(lines).toEqual([
			"not running a.md: it is not approved",
			"no scheduled workflow is approved, so nothing will run; approve one with: vaultore schedules approve <note.md>",
		]);
	});

	it("says so too when the vault has no scheduled note at all", () => {
		const lines: string[] = [];
		const report = createSkipReporter((line) => lines.push(line));

		report({ registered: 0, skipped: [] });
		report({ registered: 0, skipped: [] });

		expect(lines).toEqual(["no scheduled workflow found, so nothing will run"]);
	});

	it("says every scheduled note is Obsidian's when all are handed to it", () => {
		const lines: string[] = [];
		const report = createSkipReporter((line) => lines.push(line));

		report({ registered: 0, skipped: [], delegated: 2 });

		expect(lines).toEqual([
			"every scheduled workflow is handed to Obsidian, so nothing runs here; hand one to the agent with: vaultore schedules approve <note.md>",
		]);
	});

	it("is silent once everything scheduled is approved", () => {
		const lines: string[] = [];
		const report = createSkipReporter((line) => lines.push(line));

		report({ registered: 0, skipped: [skip("a.md")] });
		lines.length = 0;
		report({ registered: 1, skipped: [] });

		expect(lines).toEqual([]);
	});
});

describe("createGuardedRescan (#313)", () => {
	it("keeps going when a rescan fails, says why once, and says when it works again", async () => {
		const lines: string[] = [];
		const results: Array<Error | undefined> = [new Error("EIO: i/o error, scandir '/vault'"), new Error("EIO: i/o error, scandir '/vault'"), new Error("EACCES"), undefined, undefined];
		const rescan = createGuardedRescan(async () => {
			const result = results.shift();
			if (result) throw result;
		}, (line) => lines.push(line));

		for (let i = 0; i < 5; i += 1) await expect(rescan()).resolves.toBeUndefined();

		expect(lines).toEqual([
			"could not rescan the vault: EIO: i/o error, scandir '/vault'; the notes stay armed as they were, and it is tried again at the next rescan",
			"could not rescan the vault: EACCES; the notes stay armed as they were, and it is tried again at the next rescan",
			"rescanning works again",
		]);
	});
});
