import { resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { hasExplicitVault, parseArgs, toVaultRelative, vaultRootFrom } from "./args";

describe("parseArgs", () => {
	it("collects positionals and boolean flags", () => {
		const { positional, flags } = parseArgs(["run", "wf.md", "--yes", "--quiet"]);
		expect(positional).toEqual(["run", "wf.md"]);
		expect(flags).toEqual({ yes: true, quiet: true });
	});

	it("does not let a boolean flag swallow the following positional", () => {
		const { positional, flags } = parseArgs(["run", "--yes", "wf.md"]);
		expect(positional).toEqual(["run", "wf.md"]);
		expect(flags["yes"]).toBe(true);
	});

	it("does not let --skip-deps swallow the workflow path", () => {
		const { positional, flags } = parseArgs(["run", "--skip-deps", "notes/wf.md"]);
		expect(positional).toEqual(["run", "notes/wf.md"]);
		expect(flags["skip-deps"]).toBe(true);
	});

	it("reads values for value-taking flags", () => {
		const { flags } = parseArgs(["run", "wf.md", "--vault", "/vault", "--cell", "hello"]);
		expect(flags["vault"]).toBe("/vault");
		expect(flags["cell"]).toBe("hello");
	});

	it("supports --flag=value form", () => {
		const { positional, flags } = parseArgs(["run", "--vault=/vault", "wf.md"]);
		expect(positional).toEqual(["run", "wf.md"]);
		expect(flags["vault"]).toBe("/vault");
	});

	it("rejects a value-taking flag with no value instead of silently ignoring it", () => {
		expect(() => parseArgs(["run", "wf.md", "--cell"])).toThrow(/--cell requires a value/);
		expect(() => parseArgs(["run", "wf.md", "--cell", "--yes"])).toThrow(/--cell requires a value/);
	});

	it("treats everything after -- as positional", () => {
		const { positional, flags } = parseArgs(["run", "--yes", "--", "--weird-name.md"]);
		expect(positional).toEqual(["run", "--weird-name.md"]);
		expect(flags["yes"]).toBe(true);
	});
});

describe("vaultRootFrom / hasExplicitVault", () => {
	it("reports an explicit --vault", () => {
		expect(hasExplicitVault({ vault: "/vault" })).toBe(true);
		expect(hasExplicitVault({ yes: true })).toBe(false);
	});

	it("falls back to the current directory", () => {
		expect(vaultRootFrom({})).toBe(resolve(process.cwd()));
	});
});

describe("toVaultRelative", () => {
	const vaultRoot = resolve(sep, "vault");

	it("resolves a relative arg against the vault root when --vault was given", () => {
		expect(
			toVaultRelative(vaultRoot, "Workflows/digest.md", { vaultExplicit: true })
		).toBe("Workflows/digest.md");
	});

	it("resolves against the cwd when --vault was not given", () => {
		expect(toVaultRelative(resolve(process.cwd()), "digest.md")).toBe("digest.md");
	});

	it("accepts an absolute path inside the vault", () => {
		expect(
			toVaultRelative(vaultRoot, resolve(vaultRoot, "notes/a.md"), { vaultExplicit: true })
		).toBe("notes/a.md");
	});

	it("rejects a path that escapes the vault", () => {
		expect(() =>
			toVaultRelative(vaultRoot, "../outside.md", { vaultExplicit: true })
		).toThrow(/outside the vault/);
	});

	it("does not mistake a sibling starting with '..' for an escape", () => {
		expect(
			toVaultRelative(vaultRoot, "..dotfolder/a.md", { vaultExplicit: true })
		).toBe("..dotfolder/a.md");
	});
});
