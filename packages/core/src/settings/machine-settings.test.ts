import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as nodeSetTimeout } from "node:timers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireLock } from "../lock";
import { machineSettingsPath, readMachineSettings, writeMachineSettings } from "./machine-settings";

/** This machine's settings that both runners share (#269): one file, outside the vault. */

let dir: string;
let path: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "vaultore-settings-"));
	path = join(dir, "vaultore", "settings.json");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("machine settings", () => {
	it("live beside the run locks and the record", () => {
		expect(machineSettingsPath("darwin", {}, () => "/Users/me")).toBe("/Users/me/.config/vaultore/settings.json");
		expect(machineSettingsPath("win32", { APPDATA: "C:\\Users\\me\\AppData\\Roaming" }, () => "x")).toMatch(
			/vaultore[\\/]settings\.json$/
		);
	});

	it("are the defaults when the file is missing", async () => {
		expect(await readMachineSettings({ path })).toEqual({});
	});

	it("are written whole, kept across writes, and a key removed goes back to its default", async () => {
		expect(await writeMachineSettings({ lateAfterMinutes: 15 }, { path })).toEqual({ lateAfterMinutes: 15 });
		expect(await readMachineSettings({ path })).toEqual({ lateAfterMinutes: 15 });
		expect(readdirSync(join(dir, "vaultore"))).toEqual(["settings.json"]);

		expect(await writeMachineSettings({ lateAfterMinutes: undefined }, { path })).toEqual({});
	});

	// A later version may add a key; this one must not drop it.
	it("keep keys this version does not know when writing", async () => {
		await writeMachineSettings({ lateAfterMinutes: 5 }, { path });
		const raw = JSON.parse(readFileSync(path, "utf8"));
		writeFileSync(path, JSON.stringify({ ...raw, future: true }));

		await writeMachineSettings({ lateAfterMinutes: 6 }, { path });

		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ lateAfterMinutes: 6, future: true });
	});

	// A runner that guessed could disagree with the other, so no silent default.
	it.each([
		["{not json", /is not valid JSON/],
		["[]", /must hold a JSON object/],
		['{"lateAfterMinutes": 1}', /lateAfterMinutes must be a whole number of minutes from 2 to 60, got 1/],
		['{"lateAfterMinutes": "10"}', /got "10"/],
	])("refuse a file holding %s, naming it", async (content, message) => {
		await writeMachineSettings({}, { path });
		writeFileSync(path, content);
		await expect(readMachineSettings({ path })).rejects.toThrow(message);
		await expect(readMachineSettings({ path })).rejects.toThrow(path);
	});

	it("refuse to write a value out of range", async () => {
		await expect(writeMachineSettings({ lateAfterMinutes: 61 }, { path })).rejects.toThrow(
			"Late after must be a whole number of minutes from 2 to 60, got 61"
		);
	});

	// Obsidian and a vaultore command changing different settings at once
	// keep both (#291): the change is read and written under a lock.
	it("changes the file under a lock, waiting for another change, and keeps both", async () => {
		const timers = { setTimeout: (callback: () => void, ms: number) => nodeSetTimeout(callback, ms) };
		mkdirSync(dirname(path), { recursive: true });
		const release = await acquireLock(`${path}.lock`);
		const waiting = writeMachineSettings({ lateAfterMinutes: 10 }, { path, wait: { timers, ms: 2000, stepMs: 20 } });
		await new Promise((resolve) => nodeSetTimeout(resolve, 100));
		expect(() => readFileSync(path)).toThrow();

		await release();
		await waiting;
		await writeMachineSettings({ decisionsFromOtherDevices: true }, { path });

		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ lateAfterMinutes: 10, decisionsFromOtherDevices: true });
	});
});
