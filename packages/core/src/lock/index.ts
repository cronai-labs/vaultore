/**
 * @vaultore/core - a lock between VaultOre processes on one machine
 *
 * The CLI takes it around a change of its approvals file, and both runners,
 * the Obsidian plugin and the CLI, around a run of a note (#215).
 *
 * The lock is a directory, and its holder is one file inside it, named after
 * the holding process. A taker prepares that directory under a name of its
 * own, holder file included, and renames it to the lock's path. The rename
 * succeeds only when nothing is there or an empty directory is, so exactly one
 * taker gets in, and a lock is never seen without its holder: an empty lock
 * directory is nobody's.
 *
 * A process that is killed cannot release its lock. The next taker reads who
 * held it, and the lock is stale, taken over and reported, when its holder on
 * this machine
 *
 * - is a process that no longer exists;
 * - took it before this machine last started, whatever process has its id
 *   now; or
 * - is this very process, but the lock is not among the ones it holds: it was
 *   left by an earlier load of the plugin, which Obsidian reloads in the same
 *   process. The locks a process holds are recorded on `process`, which a
 *   plugin reload keeps and a window reload replaces.
 *
 * A lock whose holder runs, runs on another machine, or cannot be read is
 * never removed; the error names it.
 *
 * Taking over is safe against two takers doing it at once. The stale holder
 * file is removed by its own name, which no later holder has; what remains is
 * an empty directory, and both takers rename onto it, where one succeeds.
 * Neither step can touch the lock of a taker that got in between. This does
 * not rest on "only one of two removals succeeds": on macOS two concurrent
 * `unlink` calls for one file both report success.
 */

import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { hostname, uptime } from "node:os";
import { join } from "node:path";

/** Who holds a lock, as written into it. */
export interface LockHolder {
	pid: number;
	host: string;
	/** When it was taken, ISO 8601. */
	since: string;
	/** Which runner holds it, for people: "Obsidian", "vaultore agent". */
	by?: string;
}

/** The lock is held, or cannot be told apart from a held one. It was left alone. */
export class LockHeldError extends Error {
	constructor(
		readonly lockPath: string,
		readonly holder: LockHolder | undefined,
		message: string
	) {
		super(message);
		this.name = "LockHeldError";
	}
}

export interface LockOptions {
	/**
	 * Called when this taker removes a stale lock, whether or not it then gets
	 * the lock itself: a lock is never removed without saying so. `why`
	 * completes "process <pid>, which took it at <since>, …". Two takers that
	 * find the same stale lock at the same moment may both report it.
	 */
	onStale?: (holder: LockHolder, why: string) => void;
	/** Which runner takes it, written into the holder. */
	by?: string;
	/** Whether a process of this machine still exists. Replaceable in tests. */
	isAlive?: (pid: number) => boolean;
	/** This machine's name. Replaceable in tests. */
	host?: string;
	/** When this machine last started, in ms since the epoch. Replaceable in tests. */
	bootTime?: number;
	/** How often to try while other takers keep getting in first. */
	attempts?: number;
}

const ATTEMPTS = 5;

/**
 * How far before the boot time a holder's start must lie to count as earlier.
 * The boot time is the clock now minus the uptime, so a clock set forward
 * after the lock was taken (a time sync after waking, a resumed virtual
 * machine) moves it past the lock's start, and a live lock would look older
 * than the boot. An hour keeps ordinary corrections out of it; a lock taken
 * less than an hour before a crash and a reboot falls back to the process
 * check. A lock this process holds is never judged by the clock.
 */
const BOOT_MARGIN_MS = 60 * 60 * 1000;

/** When this machine last started, in ms since the epoch. */
export function lastBootTime(): number {
	return Date.now() - uptime() * 1000;
}

/**
 * The holder files of the locks this process holds. Kept on `process`, not in
 * this module: Obsidian reloads a plugin in the same process, with a fresh copy
 * of this module, while a run of the earlier load may still hold its lock.
 */
const HELD = Symbol.for("vaultore.locks.held");

function heldByThisProcess(): Set<string> {
	const slot = process as unknown as Record<symbol, Set<string> | undefined>;
	let held = slot[HELD];
	if (!held) {
		held = new Set<string>();
		slot[HELD] = held;
	}
	return held;
}

/** What `rename` answers when something is at the lock's path already. */
const OCCUPIED = new Set(["ENOTEMPTY", "EEXIST", "ENOTDIR", "EISDIR", "EPERM", "EACCES"]);

/**
 * Whether a process with this id exists on this machine. Only "no such
 * process" counts as gone: a process of another user answers with a
 * permission error, and anything unexpected leaves the lock standing.
 */
export function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return codeOf(err) !== "ESRCH";
	}
}

/**
 * Take the lock at `lockPath`, whose parent directory must exist. Resolves to
 * the release, which may be called more than once. Rejects with LockHeldError
 * when another taker holds it.
 */
export async function acquireLock(
	lockPath: string,
	options: LockOptions = {}
): Promise<() => Promise<void>> {
	const check: StaleCheck = {
		host: options.host ?? hostname(),
		isAlive: options.isAlive ?? processIsAlive,
		bootTime: options.bootTime ?? lastBootTime(),
		held: heldByThisProcess(),
	};
	const attempts = options.attempts ?? ATTEMPTS;

	// The lock as it will be, under a name only this taker uses.
	const token = `${process.pid}.${randomBytes(6).toString("hex")}`;
	const prepared = `${lockPath}.${token}.taking`;
	const holderName = `${token}.json`;
	const holder: LockHolder = {
		pid: process.pid,
		host: check.host,
		since: new Date().toISOString(),
		...(options.by !== undefined ? { by: options.by } : {}),
	};
	await fs.mkdir(prepared, { mode: 0o700 });

	const report = options.onStale ?? (() => {});
	const reported: LockHolder[] = [];
	// Recorded before the rename can make it visible: another taker in this
	// process that looked in between would otherwise judge it left behind.
	check.held.add(holderName);
	try {
		await fs.writeFile(join(prepared, holderName), JSON.stringify(holder) + "\n", {
			flag: "wx",
			mode: 0o600,
		});

		let notAllowed: Error | undefined;
		for (let attempt = 0; attempt < attempts; attempt += 1) {
			try {
				await fs.rename(prepared, lockPath);
			} catch (err) {
				const code = codeOf(err) ?? "";
				if (!OCCUPIED.has(code)) throw err;
				// Something is there, or (a permission error with nothing in the
				// way) the rename is not allowed at all.
				const found = await clearIfStale(lockPath, check, report, reported);
				const denied = !found && (code === "EPERM" || code === "EACCES");
				notAllowed = denied && err instanceof Error ? err : undefined;
				continue;
			}
			return releaseOf(lockPath, holderName, check.held);
		}

		if (notAllowed) throw notAllowed;
		throw new LockHeldError(
			lockPath,
			undefined,
			`Other VaultOre processes keep taking the lock ${lockPath}. It was left alone; try again in a moment`
		);
	} catch (err) {
		check.held.delete(holderName);
		await fs.rm(prepared, { recursive: true, force: true });
		throw err;
	}
}

function releaseOf(
	lockPath: string,
	holderName: string,
	held: Set<string>
): () => Promise<void> {
	let released = false;
	return async () => {
		if (released) return;
		released = true;
		// Removed from the record only once the file is gone: until then it is
		// this process's lock.
		await fs.rm(join(lockPath, holderName), { force: true });
		held.delete(holderName);
		// Empty now, so nobody's. A taker that renamed its own lock onto it in
		// the meantime made it non-empty, and then this removes nothing.
		await removeIfEmpty(lockPath);
	};
}

/** What decides whether a holder on this machine is gone. */
interface StaleCheck {
	host: string;
	isAlive: (pid: number) => boolean;
	bootTime: number;
	held: Set<string>;
}

/** "process 42 (vaultore agent)", or "process 42" when the holder does not say. */
export function describeHolder(holder: LockHolder): string {
	return holder.by ? `process ${holder.pid} (${holder.by})` : `process ${holder.pid}`;
}

/**
 * Why the holder in the file `name` no longer holds its lock, completing
 * "process <pid>, which took it at <since>, …"; undefined while it does.
 */
function staleBecause(holder: LockHolder, name: string, check: StaleCheck): string | undefined {
	// This process's own: held, whatever the clock says.
	if (holder.pid === process.pid && check.held.has(name)) return undefined;
	const since = Date.parse(holder.since);
	if (!Number.isNaN(since) && since < check.bootTime - BOOT_MARGIN_MS) {
		return "took it before this machine last started";
	}
	if (holder.pid === process.pid) {
		return "is this process, but the load of VaultOre that took it has ended (a reload)";
	}
	return check.isAlive(holder.pid) ? undefined : "is no longer running";
}

/**
 * Why `holder`, of a process other than a live load of VaultOre in this one,
 * is gone, completing "process <pid>, which took it at <since>, …";
 * undefined while it runs. The schedule record judges a claim with no outcome
 * by it, as a lock's holder is judged. Holders on another machine are never
 * gone.
 */
export function holderGoneBecause(
	holder: LockHolder,
	options: Pick<LockOptions, "isAlive" | "host" | "bootTime"> = {}
): string | undefined {
	if (holder.host !== (options.host ?? hostname())) return undefined;
	return staleBecause(holder, "", {
		host: options.host ?? hostname(),
		isAlive: options.isAlive ?? processIsAlive,
		bootTime: options.bootTime ?? lastBootTime(),
		held: new Set(),
	});
}

/**
 * Looks at what is at the lock's path. Removes a stale holder, reporting it
 * once, and an empty directory, and returns whether anything was there.
 * Throws LockHeldError for a lock that is held.
 */
async function clearIfStale(
	lockPath: string,
	check: StaleCheck,
	report: (holder: LockHolder, why: string) => void,
	reported: LockHolder[]
): Promise<boolean> {
	let names: string[];
	try {
		names = await fs.readdir(lockPath);
	} catch (err) {
		if (codeOf(err) === "ENOENT") return false; // released meanwhile, or never there
		if (codeOf(err) === "ENOTDIR") {
			throw new LockHeldError(
				lockPath,
				undefined,
				`${lockPath} is in the way and is not a VaultOre lock. It was left alone; move it away if nothing needs it`
			);
		}
		throw err;
	}

	for (const name of names) {
		const file = join(lockPath, name);
		const holder = await readHolder(file);
		if (holder === "gone") continue;

		if (holder === "unreadable") {
			// A holder file is complete before its lock exists, so this is not
			// one being written. It is not ours to judge.
			throw new LockHeldError(
				lockPath,
				undefined,
				`The lock ${lockPath} is held, and ${name} in it does not say by whom. ` +
					"It was left alone; if no VaultOre process is running, remove the lock"
			);
		}
		if (holder.host !== check.host) {
			throw new LockHeldError(
				lockPath,
				holder,
				`The lock ${lockPath} is held by ${describeHolder(holder)} on ${holder.host}, since ${holder.since}. ` +
					"This machine cannot tell whether that process still runs. It was left alone; if it does not run, remove the lock"
			);
		}
		const why = staleBecause(holder, name, check);
		if (why === undefined) {
			throw new LockHeldError(
				lockPath,
				holder,
				`The lock ${lockPath} is held by ${describeHolder(holder)}, since ${holder.since}. ` +
					"It was left alone; try again when that process has finished"
			);
		}
		// Stale. Removed by its own name, so this can never be the file of a
		// taker that got the lock after this one looked.
		await fs.rm(file, { force: true });
		if (!reported.some((r) => r.pid === holder.pid && r.since === holder.since)) {
			reported.push(holder);
			report(holder, why);
		}
	}

	// Where a rename cannot replace an empty directory (Windows), it has to go
	// first. An empty lock directory is nobody's, so this takes no one's lock.
	await removeIfEmpty(lockPath);
	return true;
}

async function readHolder(file: string): Promise<LockHolder | "unreadable" | "gone"> {
	let text: string;
	try {
		text = await fs.readFile(file, "utf8");
	} catch (err) {
		return codeOf(err) === "ENOENT" ? "gone" : "unreadable";
	}
	try {
		const parsed: unknown = JSON.parse(text);
		if (typeof parsed !== "object" || parsed === null) return "unreadable";
		const { pid, host, since, by } = parsed as Record<string, unknown>;
		if (!Number.isInteger(pid) || typeof host !== "string" || typeof since !== "string") {
			return "unreadable";
		}
		return { pid: pid as number, host, since, ...(typeof by === "string" ? { by } : {}) };
	} catch {
		return "unreadable";
	}
}

/**
 * Who holds the lock at `lockPath`, read without taking or changing it:
 * undefined when nobody does, or the holder file cannot be read. Whether that
 * holder still runs is the caller's to judge (`holderGoneBecause`).
 */
export async function readLockHolder(lockPath: string): Promise<LockHolder | undefined> {
	let names: string[];
	try {
		names = await fs.readdir(lockPath);
	} catch (err) {
		const code = codeOf(err);
		if (code === "ENOENT" || code === "ENOTDIR") return undefined;
		throw err;
	}
	for (const name of names) {
		const holder = await readHolder(join(lockPath, name));
		if (holder !== "gone" && holder !== "unreadable") return holder;
	}
	return undefined;
}

/** Removes the directory if it is empty; does nothing when it is gone or in use. */
async function removeIfEmpty(dir: string): Promise<void> {
	try {
		await fs.rmdir(dir);
	} catch (err) {
		const code = codeOf(err);
		if (code === "ENOENT" || code === "ENOTEMPTY" || code === "EEXIST") return;
		throw err;
	}
}

function codeOf(err: unknown): string | undefined {
	return (err as NodeJS.ErrnoException | undefined)?.code;
}
