import { describe, expect, it } from "vitest";
import { createSingleFlightRunner } from "./agent";

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
