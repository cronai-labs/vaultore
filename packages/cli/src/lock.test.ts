import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LockHeldError, acquireLock, processIsAlive } from "./lock";
import type { LockHolder } from "./lock";

let dir: string;
let lock: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "vaultore-lock-"));
	lock = join(dir, "state.lock");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** Leaves a lock as a command would that stopped without releasing it. */
function leaveLock(holder: Partial<LockHolder> | string): string {
	mkdirSync(lock);
	const file = join(lock, "4242.abcdef.json");
	writeFileSync(
		file,
		typeof holder === "string"
			? holder
			: JSON.stringify({ pid: 4242, host: hostname(), since: "2026-01-01T00:00:00.000Z", ...holder })
	);
	return file;
}

const gone = { isAlive: () => false };
const running = { isAlive: () => true };

describe("acquireLock", () => {
	it("takes the lock and leaves nothing behind when released", async () => {
		const release = await acquireLock(lock);
		expect(existsSync(lock)).toBe(true);

		await release();
		expect(readdirSync(dir)).toEqual([]);
	});

	it("records who holds it", async () => {
		const release = await acquireLock(lock);
		const [name] = readdirSync(lock);
		const holder = JSON.parse(readFileSync(join(lock, name ?? ""), "utf8")) as LockHolder;

		expect(holder.pid).toBe(process.pid);
		expect(holder.host).toBe(hostname());
		expect(Number.isNaN(Date.parse(holder.since))).toBe(false);
		await release();
	});

	it("refuses while it is held, says by whom, and leaves the holder's lock alone", async () => {
		const release = await acquireLock(lock);
		const before = readdirSync(lock);

		const refusal: unknown = await acquireLock(lock).catch((err: unknown) => err);

		expect(refusal).toBeInstanceOf(LockHeldError);
		expect(String(refusal)).toContain(lock);
		expect(String(refusal)).toContain(`process ${process.pid}`);
		expect(readdirSync(lock)).toEqual(before);
		expect(readdirSync(dir)).toEqual(["state.lock"]);
		await release();
	});

	it("lets exactly one of two takers in", async () => {
		const results = await Promise.allSettled([acquireLock(lock), acquireLock(lock)]);

		expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
		const refused = results.find((r) => r.status === "rejected");
		expect(refused?.status === "rejected" && refused.reason).toBeInstanceOf(LockHeldError);
	});

	it("can be released twice", async () => {
		const release = await acquireLock(lock);
		await release();
		await expect(release()).resolves.toBeUndefined();
	});

	// A command that was killed cannot release. Its lock names a process that
	// no longer exists on this machine: that, and nothing weaker, makes it stale.
	it("takes over a lock whose holder is gone, and reports it", async () => {
		leaveLock({});
		const stale: LockHolder[] = [];

		const release = await acquireLock(lock, { ...gone, onStale: (holder) => stale.push(holder) });

		expect(stale).toEqual([{ pid: 4242, host: hostname(), since: "2026-01-01T00:00:00.000Z" }]);
		const [name] = readdirSync(lock);
		expect(name).not.toBe("4242.abcdef.json");
		await release();
		expect(readdirSync(dir)).toEqual([]);
	});

	it("lets exactly one of two takers have a lock whose holder is gone", async () => {
		leaveLock({});
		const stale: LockHolder[] = [];
		const options = { onStale: (holder: LockHolder) => stale.push(holder) };
		// Only the lock that was left is stale: the winner's own process is alive.
		const isAlive = (pid: number): boolean => pid !== 4242;

		const results = await Promise.allSettled([
			acquireLock(lock, { ...options, isAlive }),
			acquireLock(lock, { ...options, isAlive }),
		]);

		expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
		// Whoever removed it says so, also the one that then lost. Both may have:
		// two removals of one file can both succeed.
		expect(stale.length).toBeGreaterThanOrEqual(1);
		expect(new Set(stale.map((holder) => holder.pid))).toEqual(new Set([4242]));
	});

	it("does not take a lock whose holder still runs", async () => {
		const file = leaveLock({});

		await expect(acquireLock(lock, running)).rejects.toBeInstanceOf(LockHeldError);
		expect(existsSync(file)).toBe(true);
	});

	// Another machine sharing the folder: this one cannot ask whether that
	// process runs, so the lock stands and the message says what to do.
	it("does not take a lock held on another machine, whatever its process id", async () => {
		const file = leaveLock({ host: "another-machine" });

		const refusal: unknown = await acquireLock(lock, gone).catch((err: unknown) => err);

		expect(refusal).toBeInstanceOf(LockHeldError);
		expect(String(refusal)).toContain("another-machine");
		expect(existsSync(file)).toBe(true);
	});

	// A lock exists only with its holder in it. An empty directory at its path
	// is what a taken-over or half-released lock leaves for a moment: nobody's.
	it("takes an empty lock directory, which is nobody's", async () => {
		mkdirSync(lock);

		const release = await acquireLock(lock);

		expect(readdirSync(lock)).toHaveLength(1);
		await release();
		expect(readdirSync(dir)).toEqual([]);
	});

	// A holder file is complete before its lock exists, so one that cannot be
	// read is not one being written. However old, it is not removed.
	it("does not take a lock whose holder it cannot read", async () => {
		const file = leaveLock("{ half writ");

		await expect(acquireLock(lock, gone)).rejects.toBeInstanceOf(LockHeldError);
		expect(readFileSync(file, "utf8")).toBe("{ half writ");
	});

	it("leaves alone something at the lock's path that is not a lock", async () => {
		writeFileSync(lock, "not ours");

		const refusal: unknown = await acquireLock(lock, gone).catch((err: unknown) => err);

		expect(refusal).toBeInstanceOf(LockHeldError);
		expect(readFileSync(lock, "utf8")).toBe("not ours");
	});

	it("fails as the file system says when the lock cannot be created at all", async () => {
		await expect(acquireLock(join(dir, "missing", "state.lock"))).rejects.toMatchObject({
			code: "ENOENT",
		});
	});
});

describe("processIsAlive", () => {
	it("says this process is alive", () => {
		expect(processIsAlive(process.pid)).toBe(true);
	});

	it("says a process that has ended is not", () => {
		const child = spawnSync(process.execPath, ["-e", ""]);
		expect(child.status).toBe(0);
		expect(processIsAlive(child.pid)).toBe(false);
	});
});
