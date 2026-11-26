import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkflowExecutor } from "./index";
import { describeRun, runSucceeded, summarizeRun } from "./run-summary";
import type { CellOutput, PlatformAdapter } from "../types";

/**
 * How a run went, for the plugin's notice and `vaultore run` (#290): the run
 * notice said "Workflow completed" when a cell had failed.
 */

vi.mock("../runtime", () => ({
	detectRuntimes: vi.fn(async () => ({ available: ["docker"], errors: new Map() })),
	execContainer: vi.fn(),
}));

import { execContainer } from "../runtime";
import { memoryRunLocks } from "../testing/run-locks";

const NOTE = `---
ore: true
name: daily
permissions:
  network: deny
  vaultRead: deny
  vaultWrite: deny
---

\`\`\`ore:shell id=fetch
echo fetched
\`\`\`

\`\`\`ore:shell id=report depends=[fetch]
echo reported
\`\`\`

\`\`\`ore:shell id=other
echo other
\`\`\`
`;

function vault(files: Record<string, string>): PlatformAdapter {
	return {
		platform: "cli",
		configDir: ".obsidian",
		readFile: async (path: string) => {
			if (!(path in files)) throw new Error(`File not found: ${path}`);
			return files[path] as string;
		},
		writeFile: async (path: string, content: string) => {
			files[path] = content;
		},
		exists: async (path: string) =>
			path in files || Object.keys(files).some((file) => file.startsWith(`${path}/`)),
		mkdirp: async () => undefined,
		listFiles: async () => [],
		getVaultRoot: async () => "/vault",
		acquireRunLock: memoryRunLocks().acquireRunLock,
		resolveInVault: async (path: string) => path,
		getSetting: () => undefined,
		setSetting: async () => undefined,
		getSecret: async () => undefined,
		setSecret: async () => undefined,
		deleteSecret: async () => undefined,
		log: () => undefined,
	} as unknown as PlatformAdapter;
}

/** Runs NOTE with the given cells failing, and summarises it as a runner does. */
async function runFailing(failing: string[], options: { targetCellId?: string; skipDependencies?: boolean } = {}) {
	const scripts: Record<string, string> = { fetch: "echo fetched", report: "echo reported", other: "echo other" };
	vi.mocked(execContainer).mockImplementation(async (_timers, _engine, opts) => {
		const fails = failing.some((id) => opts.command[2]?.trim() === scripts[id]);
		return { exitCode: fails ? 1 : 0, stdout: "out\n", stderr: fails ? "boom\n" : "", duration: 1, timedOut: false };
	});
	const ran: string[] = [];
	const workflow = await new WorkflowExecutor().runWorkflow({
		platform: vault({ "Workflows/daily.md": NOTE }),
		workflowPath: "Workflows/daily.md",
		content: NOTE,
		...options,
		emitEvent: (event, data) => {
			const cellId = (data as { cellId?: string }).cellId;
			if (event === "cell:started" && cellId !== undefined) ran.push(cellId);
		},
	});
	return summarizeRun(workflow.cells, workflow.outputs, ran);
}

beforeEach(() => {
	vi.mocked(execContainer).mockReset();
});

describe("how a run went", () => {
	it("is completed only when every cell it started succeeded", async () => {
		const summary = await runFailing([]);

		expect(summary).toEqual({ ran: ["fetch", "other", "report"], failed: [], blocked: [] });
		expect(runSucceeded(summary)).toBe(true);
		expect(describeRun("daily", summary)).toBe("daily completed");
	});

	it("names the cells that failed, out of the cells it started", async () => {
		const summary = await runFailing(["other"]);

		expect(summary.failed).toEqual(["other"]);
		expect(runSucceeded(summary)).toBe(false);
		expect(describeRun("daily", summary)).toBe("daily finished, 1 of 3 cells failed (other)");
	});

	it("counts a cell whose dependency failed apart from the cell that failed", async () => {
		const summary = await runFailing(["fetch"]);

		expect(summary).toEqual({ ran: ["fetch", "other", "report"], failed: ["fetch"], blocked: ["report"] });
		expect(describeRun("daily", summary)).toBe(
			"daily finished, 1 of 3 cells failed (fetch), 1 did not run because a cell it needs did not succeed (report)"
		);
	});

	it("counts a cell run alone whose dependency has no output as one that did not run", async () => {
		const summary = await runFailing([], { targetCellId: "report", skipDependencies: true });

		expect(summary).toEqual({ ran: ["report"], failed: [], blocked: ["report"] });
		expect(describeRun("daily", summary)).toBe(
			"daily finished, 1 of 1 did not run because a cell it needs did not succeed (report)"
		);
	});

	it("leaves out results from earlier runs that this run did not start", () => {
		const output = (cellId: string, status: CellOutput["meta"]["status"]): CellOutput => ({
			cellId,
			value: null,
			meta: { status, duration: 1, timestamp: "2026-11-26T00:00:00.000Z" },
		});
		const cells = [
			{ attributes: { id: "fetch", type: "shell" } },
			{ attributes: { id: "report", type: "shell", depends: ["fetch"] } },
		] as unknown as Parameters<typeof summarizeRun>[0];
		const outputs = new Map([
			["fetch", output("fetch", "error")],
			["report", output("report", "success")],
		]);

		const summary = summarizeRun(cells, outputs, ["report"]);

		expect(summary).toEqual({ ran: ["report"], failed: [], blocked: [] });
		expect(describeRun("daily", summary)).toBe("daily completed");
	});

	it("says how many of several cells did not run", () => {
		expect(describeRun("daily", { ran: ["a", "b", "c"], failed: ["a"], blocked: ["b", "c"] })).toBe(
			"daily finished, 1 of 3 cells failed (a), 2 did not run because a cell they need did not succeed (b, c)"
		);
	});
});
