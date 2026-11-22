import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowExecutor } from "./index";
import { RunLockHeldError } from "../lock/run-lock";
import { filesystemPlatform, makeIntegrationVaultRoot } from "../testing/integration-vault";
import type { PlatformAdapter } from "../types";

/**
 * One run per note (#215), against a real container: two runners on one
 * vault, sharing the run locks as the plugin and `vaultore agent` do, start
 * the same note; one runs it, the other is refused before anything happens.
 *
 *   bun run --cwd packages/core test:integration
 */

const NOTE = `---
ore: true
name: lock
permissions:
  network: deny
  vaultRead: deny
  vaultWrite: deny
---

\`\`\`ore:shell id=slow
sleep 3
echo ran
\`\`\`
`;

let root: string;
let locks: string;

beforeEach(() => {
	root = makeIntegrationVaultRoot();
	locks = mkdtempSync(join(tmpdir(), "vaultore-it-run-locks-"));
	writeFileSync(join(root, "wf.md"), NOTE);
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
	rmSync(locks, { recursive: true, force: true });
});

function runDirectories(): string[] {
	return readdirSync(join(root, "_vaultore", "runs", "wf"), { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name);
}

function runner(name: string): PlatformAdapter {
	return filesystemPlatform(root, { runLockDirectory: locks, runner: name });
}

describe("two runners, one note", { timeout: 180_000 }, () => {
	it("runs it once, and refuses the second runner naming the first", async () => {
		const obsidian = runner("Obsidian");
		let locked!: () => void;
		const held = new Promise<void>((resolve) => (locked = resolve));
		const acquire = obsidian.acquireRunLock.bind(obsidian);
		obsidian.acquireRunLock = async (notePath: string) => {
			const release = await acquire(notePath);
			locked();
			return release;
		};

		const content = readFileSync(join(root, "wf.md"), "utf8");
		const first = new WorkflowExecutor().runWorkflow({ platform: obsidian, workflowPath: "wf.md", content });
		await held;
		const second = await new WorkflowExecutor()
			.runWorkflow({ platform: runner("vaultore agent"), workflowPath: "wf.md", content })
			.catch((err: unknown) => err);

		expect(second).toBeInstanceOf(RunLockHeldError);
		expect(String(second)).toContain(`wf.md is already being run by process ${process.pid} (Obsidian)`);

		const workflow = await first;
		expect(workflow.outputs.get("slow")?.meta.status).toBe("success");
		// One run: one run directory beside the note's run index, and the lock
		// is gone with it.
		expect(runDirectories()).toHaveLength(1);
		expect(readdirSync(locks)).toEqual([]);

		// Released, so the next run of the note goes ahead.
		const next = readFileSync(join(root, "wf.md"), "utf8");
		await new WorkflowExecutor().runWorkflow({
			platform: runner("vaultore agent"),
			workflowPath: "wf.md",
			content: next,
		});
		expect(runDirectories()).toHaveLength(2);
	});
});
