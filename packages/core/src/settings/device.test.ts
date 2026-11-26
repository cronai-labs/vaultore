import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readDecisionDevice } from "./device";

/** The device a permission decision is bound to (#284). */

let dir: string;
let options: { devicePath: string; settingsPath: string };

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "vaultore-device-"));
	options = { devicePath: join(dir, "state", "device.json"), settingsPath: join(dir, "state", "settings.json") };
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("readDecisionDevice", () => {
	it("makes the device file once, readable by this account only, and is the same device afterwards", async () => {
		const first = await readDecisionDevice(options);
		const file = JSON.parse(readFileSync(options.devicePath, "utf8"));

		expect(file).toMatchObject({ format: "vaultore.device", version: 1, id: first.id });
		expect(file.id).toMatch(/^[0-9a-f]{32}$/);
		expect(file.key).toMatch(/^[0-9a-f]{64}$/);
		expect(statSync(options.devicePath).mode & 0o777).toBe(0o600);

		const again = await readDecisionDevice(options);
		expect(again.id).toBe(first.id);
		expect(again.sign("text")).toBe(first.sign("text"));
		expect(readdirSync(join(dir, "state"))).toEqual(["device.json"]);
	});

	it("signs with a key that is not its id, and differently on another device", async () => {
		const here = await readDecisionDevice(options);
		const elsewhere = await readDecisionDevice({ ...options, devicePath: join(dir, "other", "device.json") });

		expect(here.sign("text")).toMatch(/^[0-9a-f]{64}$/);
		expect(elsewhere.id).not.toBe(here.id);
		expect(elsewhere.sign("text")).not.toBe(here.sign("text"));
	});

	it("agrees on one device when several runners make it at once", async () => {
		const devices = await Promise.all(Array.from({ length: 8 }, () => readDecisionDevice(options)));

		expect(new Set(devices.map((device) => device.id)).size).toBe(1);
		expect(new Set(devices.map((device) => device.sign("text"))).size).toBe(1);
		expect(readdirSync(join(dir, "state"))).toEqual(["device.json"]);
	});

	it.each([
		["not JSON", "{ nope"],
		["another kind of file", JSON.stringify({ format: "other", version: 1 })],
		["a newer version", JSON.stringify({ format: "vaultore.device", version: 2, id: "a".repeat(32), key: "b".repeat(64) })],
		["a short key", JSON.stringify({ format: "vaultore.device", version: 1, id: "a".repeat(32), key: "b" })],
	])("refuses a device file that is %s, names it, and leaves it as it is", async (_what, text) => {
		await readDecisionDevice(options);
		writeFileSync(options.devicePath, text);

		await expect(readDecisionDevice(options)).rejects.toThrow(`Cannot use VaultOre's device file ${options.devicePath}`);
		expect(readFileSync(options.devicePath, "utf8")).toBe(text);
	});

	it("applies decisions from other devices only when this machine's settings say so", async () => {
		expect((await readDecisionDevice(options)).acceptOtherDevices).toBe(false);

		writeFileSync(options.settingsPath, JSON.stringify({ decisionsFromOtherDevices: true }));
		expect((await readDecisionDevice(options)).acceptOtherDevices).toBe(true);

		writeFileSync(options.settingsPath, JSON.stringify({ decisionsFromOtherDevices: "yes" }));
		await expect(readDecisionDevice(options)).rejects.toThrow("decisionsFromOtherDevices must be true or false");
	});
});
