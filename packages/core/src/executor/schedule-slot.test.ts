import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkflowExecutor, scheduledNoteOf } from "./index";
import type { UnattendedApproval } from "./index";
import { WorkflowParser } from "../parser";
import { approveNote, approvedPermissions, reviewApproval } from "../settings/schedules";
import type { VaultSchedules } from "../settings/schedules";
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

/** The note approved to run on schedule as `content` is, as Obsidian approves it. */
async function approved(content = NOTE): Promise<UnattendedApproval> {
	const note = await scheduledNoteOf(new WorkflowParser().parse(content, PATH));
	if (!note) throw new Error("no schedule");
	const schedules: VaultSchedules = { obsidianScheduling: true, obsidianBinding: "strict", notes: Object.create(null) };
	approveNote(schedules, note, "obsidian", approvedPermissions(reviewApproval(undefined, note)), new Date("2026-11-20T00:00:00Z"));
	return { approval: schedules.notes[PATH] as UnattendedApproval["approval"], binding: "content" };
}

async function scheduledRun(platform: PlatformAdapter, content = NOTE) {
	return new WorkflowExecutor().runWorkflow({ platform, workflowPath: PATH, content, scheduled: SCHEDULED, unattended: await approved(content) });
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
			// Approved before the first run wrote its output into the note.
			unattended: await approved(),
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

describe("a catch-up, which holds its slot before the run (#269)", () => {
	function held() {
		const outcomes: unknown[] = [];
		return {
			outcomes,
			claim: {
				slot: SLOT,
				finish: async (outcome: unknown) => {
					outcomes.push(outcome);
				},
			},
		};
	}

	it("finishes the slot it holds, and claims none", async () => {
		const v = vault();
		const h = held();

		await new WorkflowExecutor().runWorkflow({ platform: v.platform, workflowPath: PATH, content: NOTE, slotClaim: h.claim, unattended: await approved() });

		expect(h.outcomes).toMatchObject([{ result: "completed" }]);
		expect(v.record.slots.size).toBe(0);
	});

	it("finishes it also when the note does not parse", async () => {
		const v = vault();
		const h = held();

		await expect(
			new WorkflowExecutor().runWorkflow({ platform: v.platform, workflowPath: PATH, content: "---\nore: true\nruntime:\n  timeout: 0\n---\n", slotClaim: h.claim })
		).rejects.toThrow();

		expect(h.outcomes).toMatchObject([{ result: "failed" }]);
	});

	it("is refused together with a scheduled slot", async () => {
		const v = vault();

		await expect(
			new WorkflowExecutor().runWorkflow({ platform: v.platform, workflowPath: PATH, content: NOTE, scheduled: SCHEDULED, slotClaim: held().claim })
		).rejects.toThrow("not both");
	});
});

describe("an unattended run's permissions (#299)", () => {
	const ASKS = NOTE.replace("network: deny", "network: ask");
	const runJson = (files: Record<string, string>) => {
		const path = Object.keys(files).find((file) => file.endsWith("/run.json"));
		return JSON.parse(files[path as string] as string) as Record<string, unknown>;
	};

	it("is refused without an approval, and its slot recorded skipped with the reason", async () => {
		const v = vault();

		const run = new WorkflowExecutor().runWorkflow({ platform: v.platform, workflowPath: PATH, content: NOTE, scheduled: SCHEDULED });

		await expect(run).rejects.toThrow("is not approved to run on schedule on this computer");
		expect(execContainer).not.toHaveBeenCalled();
		expect(v.record.slots.get(KEY)).toMatchObject({ result: "skipped" });
		expect(Object.keys(v.files).some((path) => path.endsWith("/run.json"))).toBe(false);
	});

	it("is refused when the note's permissions changed since it was approved, naming when", async () => {
		const v = vault();
		const edited = NOTE.replace("vaultRead: deny", "vaultRead: allow");
		v.files[PATH] = edited;

		const run = new WorkflowExecutor().runWorkflow({ platform: v.platform, workflowPath: PATH, content: edited, scheduled: SCHEDULED, unattended: await approved() });

		await expect(run).rejects.toThrow("changed since it was approved on 2026-11-20T00:00:00.000Z; approve it again");
		expect(v.record.slots.get(KEY)).toMatchObject({ result: "skipped" });
	});

	it("is refused when a cell changed since it was approved, under strict binding, and runs under narrow", async () => {
		const edited = NOTE.replace("echo one", "echo two");
		const strict = vault();
		strict.files[PATH] = edited;

		await expect(
			new WorkflowExecutor().runWorkflow({ platform: strict.platform, workflowPath: PATH, content: edited, scheduled: SCHEDULED, unattended: await approved() })
		).rejects.toThrow("changed since it was approved");
		expect(execContainer).not.toHaveBeenCalled();

		const narrow = vault();
		narrow.files[PATH] = edited;
		await new WorkflowExecutor().runWorkflow({
			platform: narrow.platform,
			workflowPath: PATH,
			content: edited,
			scheduled: SCHEDULED,
			unattended: { ...(await approved()), binding: "schedule" },
		});
		expect(execContainer).toHaveBeenCalledTimes(1);
	});

	it("runs with the answer given at approval, asks nobody and stores nothing", async () => {
		const confirm = vi.fn(async () => true);
		const setSetting = vi.fn(async () => undefined);
		const v = vault({ confirm, setSetting } as Partial<PlatformAdapter>);
		v.files[PATH] = ASKS;
		const note = await scheduledNoteOf(new WorkflowParser().parse(ASKS, PATH));
		const schedules: VaultSchedules = { obsidianScheduling: true, obsidianBinding: "strict", notes: Object.create(null) };
		approveNote(schedules, note!, "agent", approvedPermissions(reviewApproval(undefined, note!), { network: "allow" }), new Date("2026-11-20T00:00:00Z"));

		await new WorkflowExecutor().runWorkflow({
			platform: v.platform,
			workflowPath: PATH,
			content: ASKS,
			scheduled: SCHEDULED,
			runner: "vaultore agent",
			unattended: { approval: schedules.notes[PATH]!, binding: "content" },
		});

		expect(confirm).not.toHaveBeenCalled();
		expect(setSetting).not.toHaveBeenCalled();
		const record = runJson(v.files);
		expect(record["trigger"]).toEqual({ kind: "schedule", runner: "vaultore agent", slot: SLOT.toISOString(), owner: "agent", approvedAt: "2026-11-20T00:00:00.000Z" });
		expect(record["permissions"]).toMatchObject({
			network: { value: "allow", source: "approval", at: "2026-11-20T00:00:00.000Z" },
			vaultRead: { value: "deny", source: "frontmatter" },
		});
		expect(vi.mocked(execContainer).mock.calls[0]?.[2]).toMatchObject({ networkEnabled: true });
	});

	it("records a catch-up as one, with the slot of its gap and the approval's owner", async () => {
		const v = vault();
		const finish = vi.fn(async () => undefined);

		await new WorkflowExecutor().runWorkflow({
			platform: v.platform,
			workflowPath: PATH,
			content: NOTE,
			runner: "vaultore schedules catch-up",
			slotClaim: { slot: SLOT, finish },
			unattended: await approved(),
		});

		expect(runJson(v.files)["trigger"]).toMatchObject({ kind: "catch-up", runner: "vaultore schedules catch-up", slot: SLOT.toISOString(), owner: "obsidian" });
	});

	it("records a run started by hand as manual, and refuses an approval given with one", async () => {
		const v = vault();
		await new WorkflowExecutor().runWorkflow({ platform: v.platform, workflowPath: PATH, content: NOTE, runner: "Obsidian" });
		expect(runJson(v.files)["trigger"]).toEqual({ kind: "manual", runner: "Obsidian" });
		expect(runJson(v.files)["permissions"]).toMatchObject({ network: { value: "deny", source: "frontmatter" } });

		await expect(
			new WorkflowExecutor().runWorkflow({ platform: v.platform, workflowPath: PATH, content: v.files[PATH] as string, unattended: await approved() })
		).rejects.toThrow("not for a run started by hand");
	});
});
