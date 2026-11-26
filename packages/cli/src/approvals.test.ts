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
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VaultStateStoreError } from "@vaultore/core";
import { ApprovalStore, legacyStateDir, openApprovalStore, resolveStateDir, vaultKeyFor } from "./approvals";

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
	const posix = { platform: "linux" as const, accountHome: () => "/home/u" };

	it("uses --state-dir before anything else", () => {
		expect(
			resolveStateDir({ ...posix, flag: "/srv/state", env: { XDG_CONFIG_HOME: "/xdg" } })
		).toBe("/srv/state");
	});

	// One root for all of this machine's state (#277): the run locks, the
	// schedule record and the shared settings are found the same way.
	it("uses VaultOre's folder in the account's home, as the run locks do, on macOS too", () => {
		expect(resolveStateDir({ ...posix, env: {} })).toBe("/home/u/.config/vaultore");
		expect(resolveStateDir({ platform: "darwin", accountHome: () => "/Users/u", env: {} })).toBe(
			"/Users/u/.config/vaultore"
		);
	});

	it("is moved by neither XDG_CONFIG_HOME nor HOME", () => {
		expect(resolveStateDir({ ...posix, env: { XDG_CONFIG_HOME: "/xdg", HOME: "/elsewhere" } })).toBe(
			"/home/u/.config/vaultore"
		);
	});

	it("uses %APPDATA%\\vaultore on Windows", () => {
		expect(
			resolveStateDir({
				platform: "win32",
				env: { APPDATA: "C:\\Users\\u\\AppData\\Roaming", XDG_CONFIG_HOME: "/xdg" },
			})
		).toBe(join("C:\\Users\\u\\AppData\\Roaming", "vaultore"));
	});

	it("refuses to guess on Windows without APPDATA", () => {
		expect(() => resolveStateDir({ platform: "win32", env: {} })).toThrow(/APPDATA is not set/);
	});

	it("refuses an empty --state-dir", () => {
		expect(() => resolveStateDir({ ...posix, flag: "", env: {} })).toThrow(
			/--state-dir requires a value/
		);
	});
});

describe("legacyStateDir, where the approvals were kept before", () => {
	const posix = { platform: "linux" as const, homedir: "/home/u" };

	it("was $XDG_CONFIG_HOME/vaultore when that is absolute, else ~/.config/vaultore", () => {
		expect(legacyStateDir({ ...posix, env: { XDG_CONFIG_HOME: "/xdg" } })).toBe("/xdg/vaultore");
		expect(legacyStateDir({ ...posix, env: { XDG_CONFIG_HOME: "relative/dir" } })).toBe("/home/u/.config/vaultore");
		expect(legacyStateDir({ ...posix, env: {} })).toBe("/home/u/.config/vaultore");
	});

	it("was %APPDATA%\\vaultore on Windows, as now", () => {
		expect(legacyStateDir({ platform: "win32", homedir: "C:\\Users\\u", env: { APPDATA: "C:\\A" } })).toBe(
			"C:\\A\\vaultore"
		);
	});
});

describe("openApprovalStore, moving the approvals beside the rest (#277)", () => {
	const VAULT = "/vault";
	let oldDir: string;
	let newDir: string;
	const imported: string[][] = [];

	beforeEach(async () => {
		oldDir = join(dir, "xdg", "vaultore");
		newDir = join(dir, "home", ".config", "vaultore");
		imported.length = 0;
		await new ApprovalStore(oldDir).update(VAULT, (approvals) => {
			approvals["a.md"] = APPROVAL;
			approvals["b.md"] = { ...APPROVAL, hash: "b".repeat(64) };
		});
	});

	const open = () =>
		openApprovalStore(newDir, oldDir, { onImported: (from, to) => imported.push([from, to]) });

	it("copies the old approvals once, says so, and leaves the old file as it was", async () => {
		const before = readFileSync(join(oldDir, "approvals.json"), "utf8");

		const store = await open();

		expect(Object.keys(await store.forVault(VAULT))).toEqual(["a.md", "b.md"]);
		expect(imported).toEqual([[join(oldDir, "approvals.json"), join(newDir, "approvals.json")]]);
		expect(readFileSync(join(oldDir, "approvals.json"), "utf8")).toBe(before);
	});

	it("keeps a revoke made after the move, also when every approval was revoked", async () => {
		const store = await open();
		await store.update(VAULT, (approvals) => {
			delete approvals["a.md"];
			delete approvals["b.md"];
		});

		const again = await open();

		expect(await again.forVault(VAULT)).toEqual({});
		expect(imported).toHaveLength(1);
	});

	it("copies nothing once the new file exists", async () => {
		await new ApprovalStore(newDir).update(VAULT, (approvals) => {
			approvals["c.md"] = APPROVAL;
		});

		const store = await open();

		expect(Object.keys(await store.forVault(VAULT))).toEqual(["c.md"]);
		expect(imported).toEqual([]);
	});

	it("creates nothing when there was no old file", async () => {
		rmSync(oldDir, { recursive: true });

		const store = await open();

		expect(await store.forVault(VAULT)).toEqual({});
		// Not even the folder, nor a lock in it: a command that only reads changes nothing.
		expect(existsSync(newDir)).toBe(false);
		expect(imported).toEqual([]);
	});

	it("copies nothing when the old folder is the new one", async () => {
		const store = await openApprovalStore(oldDir, oldDir, { onImported: () => imported.push(["x"]) });

		expect(Object.keys(await store.forVault(VAULT))).toEqual(["a.md", "b.md"]);
		expect(imported).toEqual([]);
	});

	it("refuses an old file it cannot use, names it, and creates no new one", async () => {
		writeFileSync(join(oldDir, "approvals.json"), "{ not json");

		await expect(open()).rejects.toThrow(VaultStateStoreError);
		await expect(open()).rejects.toThrow(join(oldDir, "approvals.json"));
		expect(existsSync(join(newDir, "approvals.json"))).toBe(false);
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

			await expect(store.forVault("/vault")).rejects.toThrow(VaultStateStoreError);
			await expect(store.forVault("/vault")).rejects.toThrow(join(dir, "approvals.json"));
		});

		it.each(cases)("is not overwritten by an update: %s", async (_name, text) => {
			writeFileSync(join(dir, "approvals.json"), text);
			const store = new ApprovalStore(dir);

			await expect(
				store.update("/vault", (approvals) => {
					approvals["a.md"] = APPROVAL;
				})
			).rejects.toThrow(VaultStateStoreError);

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

		expect(refusal).toBeInstanceOf(VaultStateStoreError);
		expect(String(refusal)).toMatch(/approvals\.json\.lock/);
		expect(await store.forVault("/vault")).toEqual({ "a.md": APPROVAL });
		expect(readdirSync(dir)).toEqual(["approvals.json"]);
	});

	// A command killed in the middle of a change cannot release its lock. The
	// next one must not need a person to clear it, and must not do it quietly.
	it("takes over a lock left by a command that is gone, and says so", async () => {
		const lockPath = join(dir, "approvals.json.lock");
		mkdirSync(lockPath);
		writeFileSync(
			join(lockPath, "4242.abcdef.json"),
			JSON.stringify({ pid: 4242, host: hostname(), since: "2026-01-01T00:00:00.000Z" })
		);
		const reports: string[] = [];
		const store = new ApprovalStore(dir, {
			lock: { isAlive: (pid) => pid !== 4242, bootTime: 0 },
			onStaleLock: (holder, path) => reports.push(`${holder.pid} ${path}`),
		});

		await store.update("/vault", (approvals) => {
			approvals["a.md"] = APPROVAL;
		});

		expect(reports).toEqual([`4242 ${lockPath}`]);
		expect(await store.forVault("/vault")).toEqual({ "a.md": APPROVAL });
		expect(readdirSync(dir)).toEqual(["approvals.json"]);
	});

	it("does not take over a lock whose command still runs", async () => {
		const lockPath = join(dir, "approvals.json.lock");
		mkdirSync(lockPath);
		writeFileSync(
			join(lockPath, "4242.abcdef.json"),
			JSON.stringify({ pid: 4242, host: hostname(), since: "2026-01-01T00:00:00.000Z" })
		);
		const store = new ApprovalStore(dir, { lock: { isAlive: () => true, bootTime: 0 } });

		await expect(
			store.update("/vault", (approvals) => {
				approvals["a.md"] = APPROVAL;
			})
		).rejects.toThrow(/process 4242/);
		expect(readdirSync(lockPath)).toEqual(["4242.abcdef.json"]);
		expect(existsSync(join(dir, "approvals.json"))).toBe(false);
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
