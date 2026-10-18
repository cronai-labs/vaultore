import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeAdapter } from "./adapter";

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
