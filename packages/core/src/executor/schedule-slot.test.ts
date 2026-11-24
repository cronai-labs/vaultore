import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkflowExecutor } from "./index";
import { RunLockHeldError } from "../lock/run-lock";
import { SlotTakenError } from "../scheduler/slot-record";
import type { PlatformAdapter } from "../types";

/**
 * One run per scheduled slot (#255): a scheduled run claims its slot before
 * the run lock, a second runner that fires the same slot is refused even after
 * the first run ended, and the slot's outcome says what the run came to.
 */

vi.mock("../runtime", () => ({
	detectRuntimes: vi.fn(async () => ({ available: ["docker"], errors: new Map() })),
	execContainer: vi.fn(),
}));

import { detectRuntimes, execContainer } from "../runtime";
import { memoryRunLocks } from "../testing/run-locks";
import { memorySlotRecord } from "../testing/slot-record";

const PATH = "Workflows/fast.md";
const SLOT = new Date("2026-11-24T10:15:00.000Z");
const KEY = `${PATH} ${SLOT.toISOString()}`;
const SCHEDULED = { schedule: "15 * * * *", slot: SLOT };

const NOTE = `---
ore: true
name: fast
schedule: "15 * * * *"
permissions:
  network: deny
  vaultRead: deny
  vaultWrite: deny
---

\`\`\`ore:shell id=one
echo one
\`\`\`
`;

function vault(overrides: Partial<PlatformAdapter> = {}) {
	const files: Record<string, string> = { [PATH]: NOTE };
	const locks = memoryRunLocks();
	const record = memorySlotRecord("Obsidian");
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
		listFiles: async (directory: string) => Object.keys(files).filter((path) => path.startsWith(`${directory}/`)),
		getVaultRoot: async () => "/vault",
		resolveInVault: async (path: string) => path,
		acquireRunLock: (notePath: string) => locks.acquireRunLock(notePath),
		claimSlot: (notePath: string, slot: typeof SCHEDULED) => record.claimSlot(notePath, slot),
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
	return { files, locks, record, logged, platform };
}

function scheduledRun(platform: PlatformAdapter, content = NOTE) {
	return new WorkflowExecutor().runWorkflow({ platform, workflowPath: PATH, content, scheduled: SCHEDULED });
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

describe("a scheduled run", () => {
	it("claims its slot, runs, and records it completed with the run's id", async () => {
		const v = vault();

		await scheduledRun(v.platform);

		expect(execContainer).toHaveBeenCalledTimes(1);
		const outcome = v.record.slots.get(KEY);
		expect(outcome?.result).toBe("completed");
		expect(outcome?.runId).toMatch(/\S/);
		expect(Object.keys(v.files).some((path) => path.endsWith(`${outcome?.runId}/run.json`))).toBe(true);
	});

	// #255: both runners fire a fast note; the first run ends before the
	// second looks. The second read the note before the first wrote into it.
	it("is refused to a second runner that fires the same slot after the first run ended", async () => {
		const v = vault();
		const readBySecond = v.files[PATH] as string;

		await scheduledRun(v.platform);
		const second = scheduledRun(v.platform, readBySecond);

		await expect(second).rejects.toBeInstanceOf(SlotTakenError);
		await expect(second).rejects.toThrow("was claimed by Obsidian. Nothing was run");
		expect(execContainer).toHaveBeenCalledTimes(1);
		expect(v.record.slots.get(KEY)?.result).toBe("completed");
	});

	// The other shape of #255: the second read the note after the first run
	// wrote into it, and used to run it again.
	it("is refused to a second runner that read the note after the first run", async () => {
		const v = vault();

		await scheduledRun(v.platform);
		await expect(scheduledRun(v.platform, v.files[PATH])).rejects.toBeInstanceOf(SlotTakenError);

		expect(execContainer).toHaveBeenCalledTimes(1);
	});

	it("runs the next slot of the same schedule", async () => {
		const v = vault();
		await scheduledRun(v.platform);

		await new WorkflowExecutor().runWorkflow({
			platform: v.platform,
			workflowPath: PATH,
			content: v.files[PATH] as string,
			scheduled: { ...SCHEDULED, slot: new Date(SLOT.getTime() + 3_600_000) },
		});

		expect(execContainer).toHaveBeenCalledTimes(2);
	});

	it("spends its slot when the note is locked, and records it skipped with the reason", async () => {
		const v = vault();
		const other = await v.locks.acquireRunLock(PATH);

		await expect(scheduledRun(v.platform)).rejects.toBeInstanceOf(RunLockHeldError);

		expect(execContainer).not.toHaveBeenCalled();
		expect(v.record.slots.get(KEY)).toMatchObject({ result: "skipped", reason: expect.stringContaining("is already being run") });
		await other.release();
		await expect(scheduledRun(v.platform)).rejects.toBeInstanceOf(SlotTakenError);
	});

	it("records a note that changed since it was read as skipped", async () => {
		const v = vault();
		v.files[PATH] = `${NOTE}\nedited\n`;

		await expect(scheduledRun(v.platform)).rejects.toThrow("changed after it was read");

		expect(v.record.slots.get(KEY)).toMatchObject({ result: "skipped", reason: expect.stringContaining("changed after it was read") });
	});

	it("records a failing cell as failed", async () => {
		const v = vault();
		vi.mocked(execContainer).mockImplementation(async () => ({
			exitCode: 1,
			stdout: "",
			stderr: "boom\n",
			duration: 1,
			timedOut: false,
		}));

		await scheduledRun(v.platform);

		expect(v.record.slots.get(KEY)?.result).toBe("failed");
	});

	it("records a run that could not go on as aborted, with the reason", async () => {
		const v = vault();
		vi.mocked(detectRuntimes).mockResolvedValueOnce({
			available: [],
			errors: new Map([["docker", "no engine here"]]),
		} as unknown as Awaited<ReturnType<typeof detectRuntimes>>);

		await expect(scheduledRun(v.platform)).rejects.toThrow();

		const outcome = v.record.slots.get(KEY);
		expect(outcome?.result).toBe("aborted");
		expect(outcome?.reason).toMatch(/\S/);
		expect(outcome?.runId).toMatch(/\S/);
	});

	it("keeps the run's result when its outcome cannot be written, and says so", async () => {
		const v = vault({
			claimSlot: async () => ({
				slot: SLOT,
				finish: async () => {
					throw new Error("disk full");
				},
			}),
		});

		await expect(scheduledRun(v.platform)).resolves.toBeDefined();
		expect(v.logged.some((line) => line.includes("could not be recorded: disk full"))).toBe(true);
	});

	it("is refused on a platform that cannot claim a slot, before anything runs", async () => {
		const v = vault({ claimSlot: undefined });

		await expect(scheduledRun(v.platform)).rejects.toThrow("cannot claim a scheduled slot");
		expect(execContainer).not.toHaveBeenCalled();
	});
});

describe("a run started by hand", () => {
	it("claims no slot", async () => {
		const v = vault();

		await new WorkflowExecutor().runWorkflow({ platform: v.platform, workflowPath: PATH, content: NOTE });

		expect(v.record.slots.size).toBe(0);
	});
});
