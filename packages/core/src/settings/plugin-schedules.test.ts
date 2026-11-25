import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pluginSchedulesPath, pluginSchedulesStore } from "./plugin-schedules";
import { VaultStateStoreError } from "./vault-state-store";

/**
 * The plugin's scheduling consent lives in the user tree, one entry per vault
 * (#276): a synced data.json can no longer turn scheduling on.
 */

let dir: string;
let path: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "vaultore-plugin-schedules-"));
	path = join(dir, "vaultore", "obsidian-schedules.json");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("the plugin's scheduling consent", () => {
	it("lives beside the run locks and the record", () => {
		expect(pluginSchedulesPath("darwin", {}, () => "/Users/me")).toBe("/Users/me/.config/vaultore/obsidian-schedules.json");
	});

	it("is off with nothing approved for a vault with no entry, and when the file is missing", async () => {
		expect(await pluginSchedulesStore({ path }).forVault("/vaults/a")).toEqual({ runScheduledWorkflows: false, approvals: {} });
	});

	it("is kept per vault, and an entry that is off with nothing approved is not stored", async () => {
		const store = pluginSchedulesStore({ path });
		await store.update("/vaults/a", (entry) => {
			entry.runScheduledWorkflows = true;
			entry.approvals["Daily.md"] = "0 9 * * *";
		});
		await store.update("/vaults/b", (entry) => {
			entry.runScheduledWorkflows = true;
		});

		expect(await store.forVault("/vaults/a")).toEqual({ runScheduledWorkflows: true, approvals: { "Daily.md": "0 9 * * *" } });
		expect(await store.forVault("/vaults/b")).toEqual({ runScheduledWorkflows: true, approvals: {} });

		await store.update("/vaults/b", (entry) => {
			entry.runScheduledWorkflows = false;
		});
		const file = JSON.parse(readFileSync(path, "utf8"));
		expect(file).toEqual({
			format: "vaultore.obsidian-schedules",
			version: 1,
			vaults: { "/vaults/a": { runScheduledWorkflows: true, approvals: { "Daily.md": "0 9 * * *" } } },
		});
	});

	it("stores a note named __proto__ as an entry like any other", async () => {
		const store = pluginSchedulesStore({ path });
		await store.update("/v", (entry) => {
			entry.approvals["__proto__"] = "* * * * *";
		});
		expect(Object.keys((await store.forVault("/v")).approvals)).toEqual(["__proto__"]);
	});

	// A runner that carried on would schedule nothing for a reason nobody sees.
	it.each([
		["{not json", /is not JSON/],
		['{"format":"other","version":1,"vaults":{}}', /is not a VaultOre scheduling approvals file/],
		['{"format":"vaultore.obsidian-schedules","version":2,"vaults":{}}', /has version 2, and this VaultOre reads version 1/],
		['{"format":"vaultore.obsidian-schedules","version":1,"vaults":{"/v":{"approvals":{}}}}', /the entry for vault \/v is incomplete/],
		['{"format":"vaultore.obsidian-schedules","version":1,"vaults":{"/v":{"runScheduledWorkflows":true,"approvals":{"a.md":1}}}}', /the approval of a.md in vault \/v is not a schedule/],
	])("refuses a file holding %s, naming it, and leaves it as it is", async (content, message) => {
		const store = pluginSchedulesStore({ path });
		await store.update("/v", (entry) => {
			entry.runScheduledWorkflows = true;
		});
		writeFileSync(path, content);

		await expect(store.forVault("/v")).rejects.toThrow(VaultStateStoreError);
		await expect(store.forVault("/v")).rejects.toThrow(message);
		await expect(store.update("/v", () => undefined)).rejects.toThrow(path);
		expect(readFileSync(path, "utf8")).toBe(content);
	});
});
