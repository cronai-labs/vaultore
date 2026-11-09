import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkflowExecutor } from "./index";
import type { PlatformAdapter } from "../types";

/**
 * Running one cell names it by id. An id no cell of the note has used to
 * select nothing: no cell ran, and the run was recorded as completed (#223).
 * A mistyped `--cell` then looks like a run that worked.
 */

vi.mock("../runtime", () => ({
	detectRuntimes: vi.fn(async () => ({ available: ["docker"], errors: new Map() })),
	execContainer: vi.fn(),
}));

import { execContainer } from "../runtime";

const NOTE = `---
ore: true
name: target
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
		resolveInVault: async (path: string) => path,
		getSetting: () => undefined,
		setSetting: async () => undefined,
		getSecret: async () => undefined,
		setSecret: async () => undefined,
		deleteSecret: async () => undefined,
		log: () => undefined,
	} as unknown as PlatformAdapter;
}

function run(files: Record<string, string>, targetCellId: string, skipDependencies = false) {
	return new WorkflowExecutor().runWorkflow({
		platform: vault(files),
		workflowPath: "Workflows/target.md",
		content: NOTE,
		targetCellId,
		skipDependencies,
	});
}

beforeEach(() => {
	vi.mocked(execContainer).mockReset();
	vi.mocked(execContainer).mockImplementation(async () => ({
		exitCode: 0,
		stdout: "out\n",
		stderr: "",
		duration: 1,
		timedOut: false,
	}));
});

describe("running one cell", () => {
	it("runs the cell it is given and the cells that one depends on", async () => {
		const workflow = await run({ "Workflows/target.md": NOTE }, "report");

		expect(Array.from(workflow.outputs.keys())).toEqual(["fetch", "report"]);
		expect(execContainer).toHaveBeenCalledTimes(2);
	});

	it.each([
		["with its dependencies", false],
		["alone", true],
	])("refuses an id no cell has, %s, naming the id and the note", async (_mode, skipDependencies) => {
		const files = { "Workflows/target.md": NOTE };

		await expect(run(files, "reprot", skipDependencies)).rejects.toThrow(
			'Cell "reprot" not found in Workflows/target.md. Its cells are: fetch, report'
		);

		// Before anything runs: no container, no run record, the note as it was.
		expect(execContainer).not.toHaveBeenCalled();
		expect(Object.keys(files)).toEqual(["Workflows/target.md"]);
		expect(files["Workflows/target.md"]).toBe(NOTE);
	});

	// An empty id used to count as "no cell named": every cell ran.
	it("refuses an empty id instead of running every cell", async () => {
		await expect(run({ "Workflows/target.md": NOTE }, "")).rejects.toThrow(
			'Cell "" not found in Workflows/target.md'
		);
		expect(execContainer).not.toHaveBeenCalled();
	});
});
