import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkflowExecutor } from "./index";
import { RunLockHeldError } from "../lock/run-lock";
import type { PlatformAdapter } from "../types";

/**
 * One run per note (#215): the executor holds the note's run lock for the
 * whole run, refuses while another run holds it, decides inside the lock
 * whether what was read is still what would run, and releases it however the
 * run ends.
 */

vi.mock("../runtime", () => ({
	detectRuntimes: vi.fn(async () => ({ available: ["docker"], errors: new Map() })),
	execContainer: vi.fn(),
}));

import { detectRuntimes, execContainer } from "../runtime";
import { memoryRunLocks } from "../testing/run-locks";
import type { MemoryRunLocks } from "../testing/run-locks";

const PATH = "Workflows/lock.md";

const NOTE = `---
ore: true
name: lock
permissions:
  network: deny
  vaultRead: deny
  vaultWrite: deny
---

\`\`\`ore:shell id=one
echo one
\`\`\`
`;

interface Vault {
	files: Record<string, string>;
	locks: MemoryRunLocks;
	logged: string[];
	platform: PlatformAdapter;
}

function vault(overrides: Partial<PlatformAdapter> = {}): Vault {
	const files: Record<string, string> = { [PATH]: NOTE };
	const locks = memoryRunLocks();
	const logged: string[] = [];
	const platform = {
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
		acquireRunLock: (notePath: string) => locks.acquireRunLock(notePath),
		getSetting: () => undefined,
		setSetting: async () => undefined,
		getSecret: async () => undefined,
		setSecret: async () => undefined,
		deleteSecret: async () => undefined,
		log: (level: string, message: string) => {
			logged.push(`${level}: ${message}`);
		},
		...overrides,
	} as unknown as PlatformAdapter;
	return { files, locks, logged, platform };
}

function run(platform: PlatformAdapter, content = NOTE) {
	return new WorkflowExecutor().runWorkflow({ platform, workflowPath: PATH, content });
}

function noEngine(): void {
	vi.mocked(detectRuntimes).mockResolvedValueOnce({
		available: [],
		errors: new Map([["docker", "no engine here"]]),
	} as unknown as Awaited<ReturnType<typeof detectRuntimes>>);
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

describe("the run lock", () => {
	it("is held while the cells run and released when the run ends", async () => {
		const v = vault();
		const heldDuringRun: boolean[] = [];
		vi.mocked(execContainer).mockImplementation(async () => {
			heldDuringRun.push(v.locks.held.has(PATH));
			return { exitCode: 0, stdout: "out\n", stderr: "", duration: 1, timedOut: false };
		});

		await run(v.platform);

		expect(heldDuringRun).toEqual([true]);
		expect(v.locks.held.size).toBe(0);
	});

	it("refuses a run while another holds the note's lock, before anything runs or is recorded", async () => {
		const v = vault();
		const other = await v.locks.acquireRunLock(PATH);

		await expect(run(v.platform)).rejects.toBeInstanceOf(RunLockHeldError);

		expect(execContainer).not.toHaveBeenCalled();
		expect(Object.keys(v.files)).toEqual([PATH]);
		expect(v.files[PATH]).toBe(NOTE);
		// The other run's lock is left as it was.
		expect(v.locks.held.has(PATH)).toBe(true);
		await other();
	});

	it("locks the note where its path really leads", async () => {
		const taken: string[] = [];
		const v = vault({
			resolveInVault: async (path: string) => (path === PATH ? "Real/lock.md" : path),
		});
		const acquire = v.platform.acquireRunLock.bind(v.platform);
		v.platform.acquireRunLock = async (notePath: string) => {
			taken.push(notePath);
			return acquire(notePath);
		};

		await run(v.platform).catch(() => undefined);

		expect(taken).toEqual(["Real/lock.md"]);
	});

	// A failing cell is recorded as its output; a run fails when, for one, no
	// container engine is there.
	it("is released when the run fails", async () => {
		const v = vault();
		noEngine();

		await expect(run(v.platform)).rejects.toThrow();

		expect(v.locks.held.size).toBe(0);
	});

	// The caller read the note, and the agent checked its approval, before the
	// lock was held. A run that finished in between wrote its outputs into it.
	it("refuses when the note changed after it was read, and releases the lock", async () => {
		const v = vault();
		v.files[PATH] = NOTE.replace("echo one", "echo changed");

		await expect(run(v.platform, NOTE)).rejects.toThrow(
			`${PATH} changed after it was read for this run, so nothing was run. Run it again`
		);

		expect(execContainer).not.toHaveBeenCalled();
		expect(Object.keys(v.files)).toEqual([PATH]);
		expect(v.locks.held.size).toBe(0);
	});

	it("keeps the run's own error when the release fails, and logs the release", async () => {
		const v = vault({
			acquireRunLock: async () => async () => {
				throw new Error("disk gone");
			},
		});
		noEngine();

		await expect(run(v.platform)).rejects.toThrow("no engine here");

		expect(v.logged).toContain(`warn: The run lock of ${PATH} could not be released: disk gone`);
	});

	it("keeps a run's result when only the release fails", async () => {
		const v = vault({
			acquireRunLock: async () => async () => {
				throw new Error("disk gone");
			},
		});

		const workflow = await run(v.platform);

		expect(Array.from(workflow.outputs.keys())).toEqual(["one"]);
		expect(v.logged).toContain(`warn: The run lock of ${PATH} could not be released: disk gone`);
	});

	it("is required: a platform without it runs nothing", async () => {
		const v = vault({ acquireRunLock: undefined });

		await expect(run(v.platform)).rejects.toThrow("it has no acquireRunLock");
		expect(execContainer).not.toHaveBeenCalled();
	});
});
