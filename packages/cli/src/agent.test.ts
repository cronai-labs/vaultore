import { describe, expect, it } from "vitest";
import { ApprovalStoreError } from "./approvals";
import {
	createApprovedRunner,
	createSingleFlightRunner,
	createSkipReporter,
	planRegistrations,
} from "./agent";
import type { ScheduledNote } from "./schedules";

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

const scheduled = (path: string, hash: string, schedule = "0 9 * * *"): ScheduledNote => ({
	path,
	schedule,
	hash,
});
const approval = (hash: string) => ({
	hash,
	schedule: "0 9 * * *",
	approvedAt: "2026-11-09T00:00:00.000Z",
});

describe("planRegistrations", () => {
	it("registers approved notes and skips the others with the reason", () => {
		const plan = planRegistrations(
			[scheduled("ok.md", "h1"), scheduled("new.md", "h2"), scheduled("edited.md", "h4")],
			{ "ok.md": approval("h1"), "edited.md": approval("h3") }
		);

		expect(plan.register.map((note) => note.path)).toEqual(["ok.md"]);
		expect(plan.skipped).toEqual([
			{ path: "new.md", reason: "it is not approved" },
			{ path: "edited.md", reason: "it changed since it was approved" },
		]);
	});

	it("registers nothing without approvals", () => {
		const plan = planRegistrations([scheduled("a.md", "h1")], {});

		expect(plan.register).toEqual([]);
		expect(plan.skipped).toEqual([{ path: "a.md", reason: "it is not approved" }]);
	});
});

describe("createApprovedRunner", () => {
	function setup(options: {
		note?: () => Promise<{ note: ScheduledNote; content: string }>;
		approvals?: () => Promise<Record<string, ReturnType<typeof approval>>>;
	}) {
		const ran: Array<[string, string]> = [];
		const refused: Array<[string, string]> = [];
		const run = createApprovedRunner({
			readNote:
				options.note ??
				(async () => ({ note: scheduled("a.md", "h1"), content: "the content checked" })),
			approvals: options.approvals ?? (async () => ({ "a.md": approval("h1") })),
			run: async (path, content) => {
				ran.push([path, content]);
			},
			onRefuse: (path, reason) => refused.push([path, reason]),
		});
		return { run, ran, refused };
	}

	it("runs an approved note with the content it checked", async () => {
		const { run, ran, refused } = setup({});

		await run("a.md");

		expect(ran).toEqual([["a.md", "the content checked"]]);
		expect(refused).toEqual([]);
	});

	it("does not run a note that changed since the last rescan", async () => {
		const { run, ran, refused } = setup({
			note: async () => ({ note: scheduled("a.md", "h2"), content: "edited" }),
		});

		await run("a.md");

		expect(ran).toEqual([]);
		expect(refused).toEqual([["a.md", "it changed since it was approved"]]);
	});

	it("does not run a note whose approval was revoked since the last rescan", async () => {
		const { run, ran, refused } = setup({ approvals: async () => ({}) });

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
			approvals: async () => {
				throw new ApprovalStoreError("Cannot use the approvals file /state/approvals.json");
			},
		});

		await run("a.md");

		expect(ran).toEqual([]);
		expect(refused).toEqual([["a.md", "Cannot use the approvals file /state/approvals.json"]]);
	});

	it("lets a failing run fail, so the caller reports it as a failed run", async () => {
		const run = createApprovedRunner({
			readNote: async () => ({ note: scheduled("a.md", "h1"), content: "c" }),
			approvals: async () => ({ "a.md": approval("h1") }),
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

	it("is silent once everything scheduled is approved", () => {
		const lines: string[] = [];
		const report = createSkipReporter((line) => lines.push(line));

		report({ registered: 0, skipped: [skip("a.md")] });
		lines.length = 0;
		report({ registered: 1, skipped: [] });

		expect(lines).toEqual([]);
	});
});
