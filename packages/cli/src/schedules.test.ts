import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeAdapter } from "./adapter";
import { ApprovalStore, vaultKeyFor } from "./approvals";
import { discoverWorkflows } from "./scan";
import {
	approveSchedules,
	formatScheduleList,
	listSchedules,
	readScheduledNote,
	revokeSchedules,
	scheduledNotes,
} from "./schedules";

const note = (schedule: string | undefined, code = "1 + 1;"): string => `---
ore: true
name: Test
${schedule === undefined ? "" : `schedule: "${schedule}"\n`}permissions:
  network: deny
---

# Test

\`\`\`ore:ts id=hello
${code}
\`\`\`
`;

let root: string;
let vault: string;
let adapter: NodeAdapter;
let store: ApprovalStore;
let key: string;

const NOW = "2026-11-09T12:00:00.000Z";
const write = (path: string, content: string): void => {
	mkdirSync(join(vault, path, ".."), { recursive: true });
	writeFileSync(join(vault, path), content);
};
const readNote = (path: string): Promise<string> => adapter.readFile(path);
const approve = (paths: string[]) =>
	approveSchedules({ paths, readNote, store, vaultKey: key, now: () => NOW });
const revoke = (paths: string[]) => revokeSchedules({ paths, store, vaultKey: key });
const listing = async () => {
	const discovered = await discoverWorkflows(adapter);
	return listSchedules(await scheduledNotes(discovered), await store.forVault(key));
};

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "vaultore-schedules-"));
	vault = join(root, "vault");
	mkdirSync(vault);
	adapter = new NodeAdapter({ vaultRoot: vault, quiet: true });
	store = new ApprovalStore(join(root, "state"));
	key = await vaultKeyFor(vault);
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("readScheduledNote", () => {
	it("gives the path, the schedule and the hash approvals are bound to", async () => {
		write("Workflows/daily.md", note("0 9 * * 1-5"));

		const { note: read, content } = await readScheduledNote(readNote, "Workflows/daily.md");

		expect(read.path).toBe("Workflows/daily.md");
		expect(read.schedule).toBe("0 9 * * 1-5");
		expect(read.hash).toMatch(/^[0-9a-f]{64}$/);
		expect(content).toBe(note("0 9 * * 1-5"));
	});

	it.each([
		["a note that is not there", "Workflows/missing.md", undefined, /cannot be read/],
		["a note that is no workflow", "plain.md", "# Just a note\n", /not a workflow note/],
		["a workflow without a schedule", "manual.md", note(undefined), /has no schedule/],
		["a schedule that is no cron expression", "bad.md", note("every monday"), /schedule 'every monday'/],
		[
			"a workflow that does not parse",
			"broken.md",
			note("* * * * *").replace("id=hello", ""),
			/missing 'id'/i,
		],
	])("refuses %s", async (_name, path, content, reason) => {
		if (content !== undefined) write(path, content);

		await expect(readScheduledNote(readNote, path)).rejects.toThrow(reason);
	});
});

describe("schedules approve", () => {
	it("stores the path and the hash of the note as it is, and says what it approved", async () => {
		write("Workflows/daily.md", note("0 9 * * 1-5"));

		const result = await approve(["Workflows/daily.md"]);

		expect(result.ok).toBe(true);
		expect(result.lines).toEqual([
			"approved Workflows/daily.md [0 9 * * 1-5]",
			`stored in ${store.file}`,
		]);
		const { note: read } = await readScheduledNote(readNote, "Workflows/daily.md");
		expect(await store.forVault(key)).toEqual({
			"Workflows/daily.md": { hash: read.hash, schedule: "0 9 * * 1-5", approvedAt: NOW },
		});
	});

	it("changes nothing when the note is already approved as it is", async () => {
		write("daily.md", note("0 9 * * 1-5"));
		await approve(["daily.md"]);
		const before = readFileSync(store.file, "utf8");

		const result = await approveSchedules({
			paths: ["daily.md"],
			readNote,
			store,
			vaultKey: key,
			now: () => "2027-01-01T00:00:00.000Z",
		});

		expect(result.ok).toBe(true);
		expect(result.lines).toEqual(["already approved daily.md [0 9 * * 1-5]"]);
		expect(readFileSync(store.file, "utf8")).toBe(before);
	});

	it("approves a changed note again and says the earlier approval is replaced", async () => {
		write("daily.md", note("0 9 * * 1-5"));
		await approve(["daily.md"]);
		write("daily.md", note("0 9 * * 1-5", "1 + 2;"));

		const result = await approveSchedules({
			paths: ["daily.md"],
			readNote,
			store,
			vaultKey: key,
			now: () => "2027-01-01T00:00:00.000Z",
		});

		expect(result.lines[0]).toBe(
			`approved daily.md [0 9 * * 1-5] (replaces the approval of ${NOW})`
		);
		expect((await listing()).map((entry) => entry.state)).toEqual(["approved"]);
	});

	it("approves none of the notes when one of them is refused", async () => {
		write("good.md", note("0 9 * * 1-5"));
		write("manual.md", note(undefined));

		const result = await approve(["good.md", "manual.md"]);

		expect(result.ok).toBe(false);
		expect(result.lines).toEqual([
			"not approving manual.md: it has no schedule",
			"nothing was approved",
		]);
		expect(await store.forVault(key)).toEqual({});
	});

	it("keeps another vault's approvals apart", async () => {
		write("daily.md", note("0 9 * * 1-5"));
		await approve(["daily.md"]);

		expect(await store.forVault("/some/other/vault")).toEqual({});
	});
});

describe("schedules revoke", () => {
	it("removes the approval", async () => {
		write("daily.md", note("0 9 * * 1-5"));
		await approve(["daily.md"]);

		const result = await revoke(["daily.md"]);

		expect(result.ok).toBe(true);
		expect(result.lines).toEqual(["revoked daily.md", `stored in ${store.file}`]);
		expect(await store.forVault(key)).toEqual({});
	});

	it("says so when there was nothing to revoke, and that is not an error", async () => {
		const result = await revoke(["never-approved.md"]);

		expect(result.ok).toBe(true);
		expect(result.lines).toEqual(["not approved: never-approved.md"]);
	});

	it("removes the approval of a note that is gone", async () => {
		write("daily.md", note("0 9 * * 1-5"));
		await approve(["daily.md"]);
		rmSync(join(vault, "daily.md"));

		expect((await revoke(["daily.md"])).lines[0]).toBe("revoked daily.md");
		expect(await store.forVault(key)).toEqual({});
	});
});

describe("schedules list", () => {
	it("gives every scheduled note its state, and approvals whose note is gone", async () => {
		write("approved.md", note("0 9 * * 1-5"));
		write("changed.md", note("0 10 * * *"));
		write("gone.md", note("0 11 * * *"));
		write("new.md", note("*/5 * * * *"));
		write("manual.md", note(undefined));
		await approve(["approved.md", "changed.md", "gone.md"]);
		write("changed.md", note("0 10 * * *", "2 + 2;"));
		rmSync(join(vault, "gone.md"));

		const entries = await listing();

		expect(entries.map((entry) => [entry.path, entry.state, entry.schedule])).toEqual([
			["approved.md", "approved", "0 9 * * 1-5"],
			["changed.md", "changed", "0 10 * * *"],
			["new.md", "not-approved", "*/5 * * * *"],
			["gone.md", "no-note", "0 11 * * *"],
		]);
	});

	it("counts a note that lost its schedule as gone, not as approved", async () => {
		write("daily.md", note("0 9 * * 1-5"));
		await approve(["daily.md"]);
		write("daily.md", note(undefined));

		expect((await listing()).map((entry) => [entry.path, entry.state])).toEqual([
			["daily.md", "no-note"],
		]);
	});

	it("prints one line per note with the state first", async () => {
		write("approved.md", note("0 9 * * 1-5"));
		write("new.md", note("*/5 * * * *"));
		await approve(["approved.md"]);

		expect(formatScheduleList(await listing())).toEqual([
			"approved                approved.md [0 9 * * 1-5]",
			"not approved            new.md [*/5 * * * *]",
		]);
	});

	it("says so when the vault has no scheduled note and no approval", async () => {
		write("manual.md", note(undefined));

		expect(formatScheduleList(await listing())).toEqual(["No scheduled workflow notes found."]);
	});
});
