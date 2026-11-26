import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { answersPath, answersStore, answersStoreFor, forgetAnswers } from "./answers";

/** The answers for runs started by hand, one file per account on a computer (#299). */

let dir: string;
let path: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "vaultore-answers-"));
	path = join(dir, "vaultore", "answers.json");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const write = (vaults: unknown) => {
	mkdirSync(join(dir, "vaultore"));
	writeFileSync(path, JSON.stringify({ format: "vaultore.permission-answers", version: 1, vaults }));
};

describe("the permission answers file", () => {
	it("lives beside the schedule approvals", () => {
		expect(answersPath("darwin", {}, () => "/Users/me")).toBe("/Users/me/.config/vaultore/answers.json");
	});

	it("holds nothing for a vault with no entry, and drops a vault with no answers left", async () => {
		const store = answersStore({ path });
		expect(await store.forVault("/v")).toEqual({ notes: {} });
		await store.update("/v", (entry) => {
			entry.notes["a.md"] = { workflowHash: "h", grantedAt: "t", network: "allow" };
		});
		await store.update("/v", (entry) => {
			delete entry.notes["a.md"];
		});
		expect(await store.forVault("/v")).toEqual({ notes: {} });
	});

	it.each([
		["an answer that is neither allow nor deny", { "a.md": { workflowHash: "h", grantedAt: "t", network: "ask" } }, 'holds network "ask", which is no answer'],
		["no content hash", { "a.md": { grantedAt: "t", network: "allow" } }, "is incomplete"],
	])("is refused, naming it, with %s", async (_what, notes, why) => {
		write({ "/v": { notes } });
		await expect(answersStore({ path }).forVault("/v")).rejects.toThrow(`the answers for a.md in vault /v ${why}`);
	});
});

describe("forgetting answers (#322)", () => {
	const kept = { workflowHash: "h", grantedAt: "2026-11-26T00:00:00.000Z", network: "deny" as const, vaultWrite: "allow" as const };

	it("forgets all of a note's answers, whatever content they were given for, and nothing else", async () => {
		const store = answersStore({ path });
		await store.update("/v", (entry) => {
			entry.notes["a.md"] = kept;
			entry.notes["b.md"] = kept;
		});

		expect(await forgetAnswers(store, "/v", "a.md")).toEqual(["network", "vaultWrite"]);

		expect(Object.keys((await store.forVault("/v")).notes)).toEqual(["b.md"]);
	});

	it("forgets only the permissions named, and keeps the note's others", async () => {
		const store = answersStore({ path });
		await store.update("/v", (entry) => {
			entry.notes["a.md"] = kept;
		});

		expect(await forgetAnswers(store, "/v", "a.md", ["network", "vaultRead"])).toEqual(["network"]);

		expect((await store.forVault("/v")).notes["a.md"]).toEqual({ workflowHash: "h", grantedAt: kept.grantedAt, vaultWrite: "allow" });
	});

	it("forgets nothing, and writes nothing, for a note with no answers", async () => {
		const store = answersStore({ path });

		expect(await forgetAnswers(store, "/v", "a.md")).toEqual([]);
		expect(await store.forVault("/v")).toEqual({ notes: {} });
	});

	it("refuses a file it cannot use, naming it, and leaves it as it is", async () => {
		write({ "/v": { notes: { "a.md": { workflowHash: "h" } } } });

		await expect(forgetAnswers(answersStore({ path }), "/v", "a.md")).rejects.toThrow(path);
	});
});

describe("sharing answers is the account's choice (#331)", () => {
	const settingsAt = (content?: unknown) => {
		mkdirSync(join(dir, "vaultore"), { recursive: true });
		const settings = join(dir, "vaultore", "settings.json");
		if (content !== undefined) writeFileSync(settings, JSON.stringify(content));
		return { settings: { path: settings }, directory: join(dir, "vaultore") };
	};

	it("shares one file by default", async () => {
		const options = settingsAt();
		expect((await answersStoreFor("obsidian", options)).file).toBe(join(dir, "vaultore", "answers.json"));
		expect((await answersStoreFor("cli", options)).file).toBe(join(dir, "vaultore", "answers.json"));
	});

	it("gives each runner its own file when not shared", async () => {
		const options = settingsAt({ shareAnswers: false });
		expect((await answersStoreFor("obsidian", options)).file).toBe(join(dir, "vaultore", "answers-obsidian.json"));
		expect((await answersStoreFor("cli", options)).file).toBe(join(dir, "vaultore", "answers-cli.json"));
	});

	it("refuses a setting that is no yes or no, naming the file, rather than guess", async () => {
		const options = settingsAt({ shareAnswers: "no" });
		await expect(answersStoreFor("cli", options)).rejects.toThrow(/settings\.json: shareAnswers must be true or false/);
	});

	it("an answer given in one runner is not used by the other when not shared", async () => {
		const options = settingsAt({ shareAnswers: false });
		await (await answersStoreFor("obsidian", options)).update("/v", (entry) => {
			entry.notes["a.md"] = { workflowHash: "h", grantedAt: "t", network: "deny" };
		});

		expect((await (await answersStoreFor("cli", options)).forVault("/v")).notes).toEqual({});
	});
});
