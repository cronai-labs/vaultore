import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApprovalStore, ApprovalStoreError, resolveStateDir, vaultKeyFor } from "./approvals";

const APPROVAL = {
	hash: "a".repeat(64),
	schedule: "0 9 * * 1-5",
	approvedAt: "2026-11-09T00:00:00.000Z",
};

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "vaultore-approvals-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("resolveStateDir", () => {
	const posix = { platform: "linux" as const, homedir: "/home/u" };

	it("uses --state-dir before anything else", () => {
		expect(
			resolveStateDir({ ...posix, flag: "/srv/state", env: { XDG_CONFIG_HOME: "/xdg" } })
		).toBe("/srv/state");
	});

	it("uses $XDG_CONFIG_HOME/vaultore when it is set", () => {
		expect(resolveStateDir({ ...posix, env: { XDG_CONFIG_HOME: "/xdg" } })).toBe("/xdg/vaultore");
	});

	it("uses ~/.config/vaultore otherwise, on macOS too", () => {
		expect(resolveStateDir({ ...posix, env: {} })).toBe("/home/u/.config/vaultore");
		expect(resolveStateDir({ platform: "darwin", homedir: "/Users/u", env: {} })).toBe(
			"/Users/u/.config/vaultore"
		);
	});

	// The XDG base directory specification: a relative path is invalid and to
	// be ignored. Taken as is, it would move the approvals with the directory
	// the command happens to run in.
	it("ignores a relative or empty XDG_CONFIG_HOME", () => {
		expect(resolveStateDir({ ...posix, env: { XDG_CONFIG_HOME: "relative/dir" } })).toBe(
			"/home/u/.config/vaultore"
		);
		expect(resolveStateDir({ ...posix, env: { XDG_CONFIG_HOME: "" } })).toBe(
			"/home/u/.config/vaultore"
		);
	});

	it("uses %APPDATA%\\vaultore on Windows", () => {
		expect(
			resolveStateDir({
				platform: "win32",
				homedir: "C:\\Users\\u",
				env: { APPDATA: "C:\\Users\\u\\AppData\\Roaming", XDG_CONFIG_HOME: "/xdg" },
			})
		).toBe("C:\\Users\\u\\AppData\\Roaming\\vaultore");
	});

	it("refuses to guess on Windows without APPDATA", () => {
		expect(() =>
			resolveStateDir({ platform: "win32", homedir: "C:\\Users\\u", env: {} })
		).toThrow(/APPDATA is not set.*--state-dir/);
	});

	it("refuses an empty --state-dir", () => {
		expect(() => resolveStateDir({ ...posix, flag: "", env: {} })).toThrow(
			/--state-dir requires a value/
		);
	});
});

describe("vaultKeyFor", () => {
	it("is the vault's real path, so a symbolic link leads to the same approvals", async () => {
		const vault = join(dir, "vault");
		mkdirSync(vault);
		symlinkSync(vault, join(dir, "link"));

		expect(await vaultKeyFor(join(dir, "link"))).toBe(await vaultKeyFor(vault));
	});

	it("names a vault that does not exist", async () => {
		await expect(vaultKeyFor(join(dir, "nowhere"))).rejects.toThrow(/nowhere.*does not exist/);
	});
});

describe("ApprovalStore", () => {
	it("has no approvals while its file does not exist, and does not create it by reading", async () => {
		const store = new ApprovalStore(join(dir, "state"));

		expect(await store.forVault("/vault")).toEqual({});
		expect(existsSync(join(dir, "state"))).toBe(false);
	});

	it("gives back what was stored, per vault", async () => {
		const store = new ApprovalStore(join(dir, "state"));
		await store.update("/vault-a", (approvals) => {
			approvals["Workflows/a.md"] = APPROVAL;
		});
		await store.update("/vault-b", (approvals) => {
			approvals["b.md"] = { ...APPROVAL, hash: "b".repeat(64) };
		});

		const again = new ApprovalStore(join(dir, "state"));
		expect(await again.forVault("/vault-a")).toEqual({ "Workflows/a.md": APPROVAL });
		expect(await again.forVault("/vault-b")).toEqual({
			"b.md": { ...APPROVAL, hash: "b".repeat(64) },
		});
		expect(await again.forVault("/vault-c")).toEqual({});
	});

	it("writes a versioned file that says what it is", async () => {
		const store = new ApprovalStore(dir);
		await store.update("/vault", (approvals) => {
			approvals["a.md"] = APPROVAL;
		});

		expect(JSON.parse(readFileSync(store.file, "utf8"))).toEqual({
			format: "vaultore.schedule-approvals",
			version: 1,
			vaults: { "/vault": { "a.md": APPROVAL } },
		});
	});

	it("drops a vault whose last approval was removed", async () => {
		const store = new ApprovalStore(dir);
		await store.update("/vault", (approvals) => {
			approvals["a.md"] = APPROVAL;
		});
		await store.update("/vault", (approvals) => {
			delete approvals["a.md"];
		});

		expect(JSON.parse(readFileSync(store.file, "utf8")).vaults).toEqual({});
	});

	it("does not write when nothing changed", async () => {
		const store = new ApprovalStore(dir);
		await store.update("/vault", (approvals) => {
			approvals["a.md"] = APPROVAL;
		});
		const before = statSync(store.file);

		const changed = await store.update("/vault", (approvals) => {
			approvals["a.md"] = { ...APPROVAL };
		});

		expect(changed).toBe(false);
		expect(statSync(store.file).ino).toBe(before.ino);
		expect(statSync(store.file).mtimeMs).toBe(before.mtimeMs);
	});

	// A file written in place can be read half-written by an agent that is
	// running; a renamed one is the old content or the new, never between.
	it("replaces the file by renaming a temporary one into place", async () => {
		const store = new ApprovalStore(dir);
		await store.update("/vault", (approvals) => {
			approvals["a.md"] = APPROVAL;
		});
		const before = statSync(store.file).ino;

		await store.update("/vault", (approvals) => {
			approvals["b.md"] = APPROVAL;
		});

		expect(statSync(store.file).ino).not.toBe(before);
		expect(readdirSync(dir)).toEqual(["approvals.json"]);
	});

	it("leaves the file as it was, and no temporary file, when the rename fails", async () => {
		const good = new ApprovalStore(dir);
		await good.update("/vault", (approvals) => {
			approvals["a.md"] = APPROVAL;
		});
		const before = readFileSync(good.file, "utf8");

		const failing = new ApprovalStore(dir, {
			rename: async () => {
				throw new Error("disk says no");
			},
		});
		await expect(
			failing.update("/vault", (approvals) => {
				approvals["b.md"] = APPROVAL;
			})
		).rejects.toThrow(/disk says no/);

		expect(readFileSync(good.file, "utf8")).toBe(before);
		expect(readdirSync(dir)).toEqual(["approvals.json"]);
	});

	describe("a file it cannot use", () => {
		const cases: Array<[string, string]> = [
			["not JSON", "{ not json"],
			["JSON of another shape", JSON.stringify(["a.md"])],
			["another format", JSON.stringify({ format: "something-else", version: 1, vaults: {} })],
			[
				"a version it does not know",
				JSON.stringify({ format: "vaultore.schedule-approvals", version: 2, vaults: {} }),
			],
			[
				"an approval without a hash",
				JSON.stringify({
					format: "vaultore.schedule-approvals",
					version: 1,
					vaults: { "/vault": { "a.md": { schedule: "* * * * *", approvedAt: "x" } } },
				}),
			],
		];

		it.each(cases)("is an error naming the file, not an empty list: %s", async (_name, text) => {
			writeFileSync(join(dir, "approvals.json"), text);
			const store = new ApprovalStore(dir);

			await expect(store.forVault("/vault")).rejects.toThrow(ApprovalStoreError);
			await expect(store.forVault("/vault")).rejects.toThrow(join(dir, "approvals.json"));
		});

		it.each(cases)("is not overwritten by an update: %s", async (_name, text) => {
			writeFileSync(join(dir, "approvals.json"), text);
			const store = new ApprovalStore(dir);

			await expect(
				store.update("/vault", (approvals) => {
					approvals["a.md"] = APPROVAL;
				})
			).rejects.toThrow(ApprovalStoreError);

			expect(readFileSync(join(dir, "approvals.json"), "utf8")).toBe(text);
			expect(readdirSync(dir)).toEqual(["approvals.json"]);
		});
	});

	// Two commands changing the list at once would each write what they read
	// plus their own change, and the later one would drop the earlier one's.
	it("refuses an update while another one holds the lock, and says where the lock is", async () => {
		const store = new ApprovalStore(dir);
		let refusal: unknown;

		await store.update("/vault", async (approvals) => {
			approvals["a.md"] = APPROVAL;
			refusal = await store
				.update("/vault", (again) => {
					again["b.md"] = APPROVAL;
				})
				.catch((err: unknown) => err);
		});

		expect(refusal).toBeInstanceOf(ApprovalStoreError);
		expect(String(refusal)).toMatch(/approvals\.json\.lock/);
		expect(await store.forVault("/vault")).toEqual({ "a.md": APPROVAL });
		expect(readdirSync(dir)).toEqual(["approvals.json"]);
	});

	it("releases the lock when the change throws", async () => {
		const store = new ApprovalStore(dir);
		await expect(
			store.update("/vault", () => {
				throw new Error("changed my mind");
			})
		).rejects.toThrow(/changed my mind/);

		await store.update("/vault", (approvals) => {
			approvals["a.md"] = APPROVAL;
		});
		expect(await store.forVault("/vault")).toEqual({ "a.md": APPROVAL });
	});
});
