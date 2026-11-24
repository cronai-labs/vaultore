import { resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import {
	DEFAULT_RESCAN_SECONDS,
	configDirFrom,
	hasExplicitVault,
	keepDaysFrom,
	parseArgs,
	slotFrom,
	rescanSecondsFrom,
	toVaultRelative,
	vaultRootFrom,
} from "./args";

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

	it("reads --config-dir <name> as the usage text writes it", () => {
		const { positional, flags } = parseArgs(["run", "--config-dir", ".cfg", "wf.md"]);
		expect(positional).toEqual(["run", "wf.md"]);
		expect(configDirFrom(flags)).toBe(".cfg");
	});

	it("refuses a flag it does not know and names it", () => {
		expect(() => parseArgs(["agent", "--yess"])).toThrow(/unknown option --yess/);
		expect(() => parseArgs(["agent", "--rescann", "5"])).toThrow(/unknown option --rescann/);
		expect(() => parseArgs(["run", "wf.md", "--vaultt=/vault"])).toThrow(/unknown option --vaultt/);
	});

	it("accepts every flag the commands read", () => {
		const { flags } = parseArgs([
			"--vault", "/vault", "--config-dir", ".cfg", "--state-dir", "/state", "--cell", "a",
			"--rescan", "60", "--out", "m.json",
			"--skip-deps", "--yes", "--quiet", "--help", "--version",
		]);
		expect(flags).toEqual({
			vault: "/vault",
			"config-dir": ".cfg",
			"state-dir": "/state",
			cell: "a",
			rescan: "60",
			out: "m.json",
			"skip-deps": true,
			yes: true,
			quiet: true,
			help: true,
			version: true,
		});
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

describe("rescanSecondsFrom", () => {
	it("defaults when --rescan is absent", () => {
		expect(rescanSecondsFrom({})).toBe(DEFAULT_RESCAN_SECONDS);
	});

	it("accepts a positive number of seconds", () => {
		expect(rescanSecondsFrom(parseArgs(["agent", "--rescan", "60"]).flags)).toBe(60);
		expect(rescanSecondsFrom(parseArgs(["agent", "--rescan=2.5"]).flags)).toBe(2.5);
	});

	// A bad value used to become 300 silently (NaN || 300), and a negative one
	// went straight to setInterval, which fires it back to back.
	it.each(["-5", "0", "abc", "", "Infinity", "1e10"])("rejects --rescan=%s", (value) => {
		expect(() => rescanSecondsFrom(parseArgs(["agent", `--rescan=${value}`]).flags)).toThrow(
			new RegExp(`--rescan must be .*got '${value.replace("+", "\\+")}'`)
		);
	});
});

describe("keepDaysFrom", () => {
	it("keeps 30 days when --keep-days is absent", () => {
		expect(keepDaysFrom({})).toBe(30);
	});

	it("accepts a whole number of days from 0 to 30", () => {
		expect(keepDaysFrom(parseArgs(["agent", "--keep-days", "0"]).flags)).toBe(0);
		expect(keepDaysFrom(parseArgs(["agent", "--keep-days=7"]).flags)).toBe(7);
		expect(keepDaysFrom(parseArgs(["agent", "--keep-days", "30"]).flags)).toBe(30);
	});

	// 30 days is the most the record keeps (#255); more is refused, not cut.
	it.each(["31", "-1", "1.5", "abc", "", "1e3"])("rejects --keep-days=%s", (value) => {
		expect(() => keepDaysFrom(parseArgs(["agent", `--keep-days=${value}`]).flags)).toThrow(
			`--keep-days must be a whole number of days from 0 to 30, got '${value}'`
		);
	});
});

describe("slotFrom", () => {
	it("reads the slot a catch-up or dismissal names, as the log prints it", () => {
		expect(slotFrom(["Workflows/a.md"])).toBeUndefined();
		expect(slotFrom(["Workflows/a.md", "2026-11-24T11:15:00.000Z"])).toEqual(new Date("2026-11-24T11:15:00.000Z"));
	});

	it.each(["yesterday", "11:15", "2026-11-24", "2026-13-40T99:99:00Z"])("refuses '%s'", (raw) => {
		expect(() => slotFrom(["Workflows/a.md", raw])).toThrow("is not a slot");
	});

	it("refuses a third argument", () => {
		expect(() => slotFrom(["a.md", "2026-11-24T11:15:00Z", "b.md"])).toThrow("at most one slot");
	});
});

