import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeAdapter } from "./adapter";
import { SlotTakenError, readSlotRecord } from "@vaultore/core";

/** The CLI's answer to where a vault path leads, against real symlinks. */

let base: string;

beforeEach(() => {
	base = mkdtempSync(join(tmpdir(), "vaultore-cli-"));
	mkdirSync(join(base, "vault/notes"), { recursive: true });
	mkdirSync(join(base, "outside"));
	symlinkSync(join(base, "outside"), join(base, "vault/notes/x"));
});

afterEach(() => {
	rmSync(base, { recursive: true, force: true });
});

describe("NodeAdapter.resolveInVault", () => {
	it("refuses a path through a symlink that leads outside the vault", async () => {
		const adapter = new NodeAdapter({ vaultRoot: join(base, "vault"), quiet: true });
		await expect(adapter.resolveInVault("notes/x/authorized_keys")).rejects.toThrow(/outside the vault/);
	});

	it("returns a plain vault path", async () => {
		const adapter = new NodeAdapter({ vaultRoot: join(base, "vault"), quiet: true });
		expect(await adapter.resolveInVault("notes/new.md")).toBe("notes/new.md");
	});
});

describe("NodeAdapter.configDir", () => {
	it("defaults to Obsidian's config folder", () => {
		const adapter = new NodeAdapter({ vaultRoot: join(base, "vault"), quiet: true });
		expect(adapter.configDir).toBe(".obsidian");
	});

	it("lists no files from the configured or the default config folder", async () => {
		const vault = join(base, "vault");
		for (const dir of [".config-desk/plugins/vaultore", ".obsidian/plugins/other"]) {
			mkdirSync(join(vault, dir), { recursive: true });
			writeFileSync(join(vault, dir, "main.md"), "x");
		}
		writeFileSync(join(vault, "notes/wf.md"), "x");

		const adapter = new NodeAdapter({ vaultRoot: vault, configDir: ".config-desk", quiet: true });

		expect(adapter.configDir).toBe(".config-desk");
		expect(await adapter.listFiles("")).toEqual(["notes/wf.md"]);
	});
});

// One run per note across runners (#215). The plugin's side is tested in
// packages/obsidian; both use core's acquireRunLock.
describe("NodeAdapter.acquireRunLock", () => {
	function adapter(runner: string): NodeAdapter {
		return new NodeAdapter({
			vaultRoot: join(base, "vault"),
			quiet: true,
			runner,
			runLockDirectory: join(base, "locks"),
		});
	}

	it("refuses a second runner while the first runs the note, naming the first", async () => {
		writeFileSync(join(base, "vault/notes/wf.md"), "---\nore: true\n---\n");
		const release = await adapter("vaultore agent").acquireRunLock("notes/wf.md");

		await expect(adapter("vaultore run").acquireRunLock("notes/wf.md")).rejects.toThrow(
			`notes/wf.md is already being run by process ${process.pid} (vaultore agent)`
		);

		await release.release();
		await (await adapter("vaultore run").acquireRunLock("notes/wf.md")).release();
	});
});

// One run per scheduled slot (#255): the plugin's side is tested in
// packages/obsidian; both use core's claimSlot.
describe("NodeAdapter.claimSlot", () => {
	const slot = { schedule: "15 * * * *", slot: new Date("2026-11-24T10:15:00.000Z") };

	function adapter(runner: string, keepDays?: number): NodeAdapter {
		return new NodeAdapter({
			vaultRoot: join(base, "vault"),
			quiet: true,
			runner,
			slotDirectory: join(base, "slots"),
			...(keepDays !== undefined ? { keepDays } : {}),
		});
	}

	it("refuses a slot another runner claimed, naming it, and records the runner", async () => {
		writeFileSync(join(base, "vault/notes/wf.md"), "---\nore: true\n---\n");
		const claim = await adapter("vaultore agent").claimSlot("notes/wf.md", slot);
		await claim.finish({ result: "completed" });

		const second = adapter("vaultore run").claimSlot("notes/wf.md", slot);
		await expect(second).rejects.toBeInstanceOf(SlotTakenError);
		await expect(second).rejects.toThrow(`claimed by process ${process.pid} (vaultore agent)`);

		const [entry] = await readSlotRecord({ directory: join(base, "slots"), vaultRoot: join(base, "vault") });
		expect(entry).toMatchObject({ note: "notes/wf.md", state: "completed" });
		expect(entry?.claimedBy.by).toBe("vaultore agent");
	});

	it("prunes by its --keep-days when it claims", async () => {
		writeFileSync(join(base, "vault/notes/wf.md"), "---\nore: true\n---\n");
		const old = { ...slot, slot: new Date(Date.now() - 3 * 24 * 3_600_000) };
		await (await adapter("vaultore agent").claimSlot("notes/wf.md", old)).finish({ result: "completed" });

		await adapter("vaultore agent", 1).claimSlot("notes/wf.md", { ...slot, slot: new Date() });

		const slots = await readSlotRecord({ directory: join(base, "slots") });
		expect(slots.map((entry) => entry.slot.getTime() === old.slot.getTime())).toEqual([false]);
	});
});
