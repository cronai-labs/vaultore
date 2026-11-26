import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { answersPath, answersStore } from "./answers";

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
