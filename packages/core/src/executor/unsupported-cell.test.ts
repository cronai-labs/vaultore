import { describe, expect, it, vi } from "vitest";
import { WorkflowExecutor, unsupportedCellMessage } from "./index";
import { nodeTimers } from "../testing/timers";
import { memoryRunLocks } from "../testing/run-locks";
import type { PlatformAdapter } from "../types";

/**
 * A cell the parser accepts but VaultOre does not run (`ore:py`, `ore:go`)
 * fails with a message that says what to do, and names no version (#279).
 */

vi.mock("../runtime", () => ({
	detectRuntimes: vi.fn(async () => ({ available: ["docker"], errors: new Map() })),
	execContainer: vi.fn(),
}));

function platformWith(files: Record<string, string>): PlatformAdapter {
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
		exists: async (path: string) => path in files,
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
		timers: nodeTimers,
	} as unknown as PlatformAdapter;
}

describe("a cell VaultOre does not run", () => {
	it.each(["py", "go"])("ore:%s fails with what runs instead and what to do", async (type) => {
		const content = `---\nore: true\nname: unsupported\n---\n\n\`\`\`ore:${type} id=calc\nprint(1)\n\`\`\`\n`;
		const files: Record<string, string> = { "wf.md": content };

		const result = await new WorkflowExecutor().runWorkflow({ platform: platformWith(files), workflowPath: "wf.md", content });

		const output = result.outputs.get("calc");
		expect(output?.meta.status).toBe("error");
		expect(output?.meta.error).toBe(
			`Cell "calc" is an ore:${type} cell, which VaultOre does not run. ` +
				"It runs ore:ts, ore:shell and ore:ai cells: rewrite the cell as one of those, or remove it. " +
				"Cells that do not depend on it still run."
		);
		expect(output?.meta.error).not.toMatch(/v\d/);
		// The user reads it in the note, under the cell.
		expect(files["wf.md"]).toContain(`Cell "calc" is an ore:${type} cell`);
	});

	it("names each runnable type once, in order", () => {
		expect(unsupportedCellMessage("x", "py")).toContain("It runs ore:ts, ore:shell and ore:ai cells");
	});
});
