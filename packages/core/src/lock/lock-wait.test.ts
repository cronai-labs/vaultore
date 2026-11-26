import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as nodeSetTimeout } from "node:timers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LockHeldError, acquireLock, acquireLockWaiting } from "./index";

/** A change of a shared file waits a moment for another one, instead of failing (#291). */

let dir: string;
const timers = { setTimeout: (callback: () => void, ms: number) => nodeSetTimeout(callback, ms) };

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "vaultore-lock-wait-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("acquireLockWaiting", () => {
	it("gets the lock once its holder lets go within the wait", async () => {
		const path = join(dir, "a.lock");
		const release = await acquireLock(path);
		nodeSetTimeout(() => void release(), 150);

		const started = Date.now();
		const second = await acquireLockWaiting(path, { wait: { timers, ms: 2000, stepMs: 20 } });

		expect(Date.now() - started).toBeGreaterThanOrEqual(100);
		await second();
	});

	it("gives up after the wait, naming the holder", async () => {
		const path = join(dir, "a.lock");
		const release = await acquireLock(path, { by: "vaultore agent" });
		try {
			await expect(acquireLockWaiting(path, { wait: { timers, ms: 100, stepMs: 20 } })).rejects.toThrow(
				/is held by process \d+ \(vaultore agent\)/
			);
		} finally {
			await release();
		}
	});

	it("refuses at once without a wait", async () => {
		const path = join(dir, "a.lock");
		const release = await acquireLock(path);
		try {
			const started = Date.now();
			await expect(acquireLockWaiting(path)).rejects.toBeInstanceOf(LockHeldError);
			expect(Date.now() - started).toBeLessThan(100);
		} finally {
			await release();
		}
	});

	it.each([
		["held from another machine", (lock: string) => writeFileSync(join(lock, "1.json"), JSON.stringify({ pid: 1, host: "elsewhere", since: "2026-11-26T00:00:00Z" })), "remote"],
		["whose holder cannot be read", (lock: string) => writeFileSync(join(lock, "1.json"), "{"), "unreadable"],
	])("does not wait for a lock %s, as that does not end by itself", async (_what, plant, kind) => {
		const path = join(dir, "a.lock");
		mkdirSync(path);
		plant(path);

		const started = Date.now();
		const error = await acquireLockWaiting(path, { wait: { timers, ms: 2000 } }).catch((err: unknown) => err);

		expect(error).toBeInstanceOf(LockHeldError);
		expect((error as LockHeldError).kind).toBe(kind);
		expect(Date.now() - started).toBeLessThan(500);
	});
});
