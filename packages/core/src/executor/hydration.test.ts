import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkflowExecutor } from "./index";
import type { PlatformAdapter } from "../types";

/**
 * A cell that does not run in this run answers with the output an earlier run
 * recorded. Which record that is comes from the cell's callout in the note:
 * the link under `> [!ore-output] <id>`.
 */

vi.mock("../runtime", () => ({
	detectRuntimes: vi.fn(async () => ({ available: ["docker"], errors: new Map() })),
	execContainer: vi.fn(),
}));

import { execContainer } from "../runtime";

const CELLS = `---
ore: true
name: hydration
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

const record = (cellId: string | undefined, value: unknown) =>
	JSON.stringify({
		...(cellId === undefined ? {} : { cellId }),
		value,
		meta: { status: "success", duration: 1, timestamp: "2026-01-01T00:00:00.000Z" },
	});

function vault(files: Record<string, string>, logs: string[]): PlatformAdapter {
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
		log: (level: string, message: string) => {
			if (level === "warn") logs.push(message);
		},
	} as unknown as PlatformAdapter;
}

/** Runs `report` alone, with `fetch` answered by what the callout links to. */
async function runReport(link: string, files: Record<string, string>) {
	const logs: string[] = [];
	const content = `${CELLS}\n> [!ore-output] fetch\n> json: [[${link}]]\n`;
	const workflow = await new WorkflowExecutor().runWorkflow({
		platform: vault({ ...files, "wf.md": content }, logs),
		workflowPath: "wf.md",
		content,
		targetCellId: "report",
		skipDependencies: true,
	});
	return { fetch: workflow.outputs.get("fetch"), report: workflow.outputs.get("report"), logs };
}

beforeEach(() => {
	vi.mocked(execContainer).mockReset();
	vi.mocked(execContainer).mockResolvedValue({
		exitCode: 0,
		stdout: "reported\n",
		stderr: "",
		duration: 1,
		timedOut: false,
	});
});

describe("recorded outputs", () => {
	// Earlier versions named the file differently for some ids. Nothing here
	// computes a name: the record is found where the callout says it is.
	it("reads a record from the path the callout gives, whatever the file is called", async () => {
		const path = "_vaultore/runs/wf/2026-01-01T00-00-00-000Z-abc123/some_other-name.json";
		const { fetch, report } = await runReport(path, { [path]: record("fetch", "from the earlier run") });

		expect(fetch?.value).toBe("from the earlier run");
		expect(report?.meta.status).toBe("success");
	});

	it("does not take a record that names no cell", async () => {
		const path = "_vaultore/runs/wf/earlier/anonymous.json";
		const { fetch } = await runReport(path, { [path]: record(undefined, "whose?") });

		expect(fetch).toBeUndefined();
	});
});
