import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveInVaultRoot } from "./confine";

/**
 * Where a vault path really leads, with symbolic links on a real file system.
 * A cell with vaultWrite can plant links through its mount; the host must not
 * follow one out of the vault.
 */

let base: string;
let vault: string;
let outside: string;

beforeEach(() => {
	base = mkdtempSync(join(tmpdir(), "vaultore-confine-"));
	vault = join(base, "vault");
	outside = join(base, "outside");
	mkdirSync(join(vault, "notes"), { recursive: true });
	mkdirSync(join(vault, "real"));
	mkdirSync(outside);
	writeFileSync(join(vault, "real/a.md"), "a");
	writeFileSync(join(outside, "secret.md"), "s");
});

afterEach(() => {
	rmSync(base, { recursive: true, force: true });
});

describe("resolveInVaultRoot", () => {
	it("returns a plain path unchanged", async () => {
		expect(await resolveInVaultRoot(vault, "real/a.md")).toBe("real/a.md");
	});

	it("accepts a path that does not exist yet", async () => {
		expect(await resolveInVaultRoot(vault, "new/deeper/note.md")).toBe("new/deeper/note.md");
	});

	it("normalises empty and '.' segments", async () => {
		expect(await resolveInVaultRoot(vault, "./real//a.md")).toBe("real/a.md");
	});

	for (const path of ["../outside/secret.md", "real/../../outside/secret.md", "/etc/passwd", "C:/x"]) {
		it(`refuses ${path}`, async () => {
			await expect(resolveInVaultRoot(vault, path)).rejects.toThrow(/outside the vault/);
		});
	}

	it("refuses a directory symlink that leads outside", async () => {
		symlinkSync(outside, join(vault, "notes/x"));
		await expect(resolveInVaultRoot(vault, "notes/x/secret.md")).rejects.toThrow(
			/notes\/x.*outside the vault/
		);
		await expect(resolveInVaultRoot(vault, "notes/x/new.md")).rejects.toThrow(/outside the vault/);
	});

	it("refuses a relative directory symlink that climbs out", async () => {
		symlinkSync("../../outside", join(vault, "notes/up"));
		await expect(resolveInVaultRoot(vault, "notes/up/secret.md")).rejects.toThrow(/outside the vault/);
	});

	it("refuses a dangling directory symlink", async () => {
		symlinkSync(join(base, "nowhere"), join(vault, "notes/gone"));
		await expect(resolveInVaultRoot(vault, "notes/gone/x.md")).rejects.toThrow(/notes\/gone/);
	});

	it("follows a directory symlink that stays inside, to the real path", async () => {
		symlinkSync("../real", join(vault, "notes/alias"));
		expect(await resolveInVaultRoot(vault, "notes/alias/a.md")).toBe("real/a.md");
		expect(await resolveInVaultRoot(vault, "notes/alias/new.md")).toBe("real/new.md");
	});

	it("refuses a symlink as the last component, wherever it points", async () => {
		symlinkSync(join(outside, "secret.md"), join(vault, "notes/out.md"));
		symlinkSync("../real/a.md", join(vault, "notes/in.md"));
		await expect(resolveInVaultRoot(vault, "notes/out.md")).rejects.toThrow(/symbolic link/);
		await expect(resolveInVaultRoot(vault, "notes/in.md")).rejects.toThrow(/symbolic link/);
	});

	it("works when the vault root itself is reached through a symlink", async () => {
		const linkedRoot = join(base, "linked-vault");
		symlinkSync(vault, linkedRoot);
		expect(await resolveInVaultRoot(linkedRoot, "real/a.md")).toBe("real/a.md");
	});
});
