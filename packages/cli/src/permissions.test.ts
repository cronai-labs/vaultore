import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { answersStore } from "@vaultore/core";
import { forgetNoteAnswers, permissionNamesFrom } from "./permissions";

/** `vaultore permissions forget` (#322). */

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "vaultore-cli-forget-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("permissionNamesFrom", () => {
	it("is every permission when none is named", () => {
		expect(permissionNamesFrom([])).toEqual(["network", "buildNetwork", "vaultRead", "vaultWrite"]);
	});

	it("refuses a name it does not know, naming those it does", () => {
		expect(() => permissionNamesFrom(["network", "netwrok"])).toThrow(
			"no such permission: netwrok; the permissions are network, buildNetwork, vaultRead, vaultWrite"
		);
	});
});

describe("forgetNoteAnswers", () => {
	it("forgets the answers and says which, and where they were kept", async () => {
		const store = answersStore({ path: join(dir, "answers.json") });
		await store.update("/v", (entry) => {
			entry.notes["a.md"] = { workflowHash: "h", grantedAt: "2026-11-26T00:00:00.000Z", network: "deny" };
		});

		const line = await forgetNoteAnswers({ store, vaultKey: "/v", notePath: "a.md", names: permissionNamesFrom([]) });

		expect(line).toBe(`forgot the answers to network for a.md; the next run started by hand asks again (in ${join(dir, "answers.json")})`);
		expect((await store.forVault("/v")).notes).toEqual({});
	});

	it("says when there was nothing to forget", async () => {
		const store = answersStore({ path: join(dir, "answers.json") });

		expect(await forgetNoteAnswers({ store, vaultKey: "/v", notePath: "a.md", names: ["vaultWrite"] })).toBe(
			"no answers kept for a.md on this computer for vaultWrite; nothing to forget"
		);
	});
});
