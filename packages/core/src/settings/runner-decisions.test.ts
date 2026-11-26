import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PLUGIN_ID, cliConfigPath, pluginSettingsPath, readRunnerDecisions } from "./runner-decisions";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "vaultore-runner-decisions-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("where each runner keeps its answers (#299)", () => {
	it("names the plugin's folder by the plugin's id", () => {
		const manifest = JSON.parse(readFileSync(join(__dirname, "../../../../manifest.json"), "utf8")) as { id: string };
		expect(PLUGIN_ID).toBe(manifest.id);
	});

	it("finds the plugin's settings under the vault's config folder, and the CLI's under .vaultore", () => {
		expect(pluginSettingsPath("/v", ".config-obsidian")).toBe(join("/v", ".config-obsidian", "plugins", "vaultore", "data.json"));
		expect(cliConfigPath("/v")).toBe(join("/v", ".vaultore", "config.json"));
	});
});

describe("readRunnerDecisions", () => {
	it("returns the file's deviceDecisions and names the file", async () => {
		const file = join(dir, "data.json");
		writeFileSync(file, JSON.stringify({ outputRoot: "_vaultore", deviceDecisions: { "wf.md": {} } }));

		expect(await readRunnerDecisions(file)).toEqual({ file, decisions: { "wf.md": {} } });
	});

	it("returns nothing for a file that does not exist", async () => {
		expect(await readRunnerDecisions(join(dir, "missing.json"))).toBeUndefined();
	});

	it("returns no decisions for a file without them, or that is not an object", async () => {
		const file = join(dir, "data.json");
		writeFileSync(file, "[1]");
		expect(await readRunnerDecisions(file)).toEqual({ file, decisions: undefined });
	});

	it("refuses a file that is not JSON, naming it", async () => {
		const file = join(dir, "data.json");
		writeFileSync(file, "{ half");
		await expect(readRunnerDecisions(file)).rejects.toThrow(`Cannot read the permission answers in ${file}: it is not JSON`);
	});

	it("refuses a file that cannot be read, naming it", async () => {
		await expect(readRunnerDecisions(dir)).rejects.toThrow(`Cannot read the permission answers in ${dir}:`);
	});
});
