/**
 * @vaultore/cli - a lock between vaultore commands on one machine
 *
 * The lock is a directory, and its holder is one file inside it, named after
 * the holding process. A command prepares that directory under a name of its
 * own, holder file included, and renames it to the lock's path. The rename
 * succeeds only when nothing is there or an empty directory is, so exactly one
 * command gets in, and a lock is never seen without its holder: an empty lock
 * directory is nobody's.
 *
 * A command that is killed cannot release its lock. The next one reads who
 * held it: when that process no longer exists on this machine, the lock is
 * stale, and it is taken over and reported. A lock whose holder runs, runs on
 * another machine, or cannot be read is never removed; the error names it.
 *
 * Taking over is safe against two commands doing it at once. The stale holder
 * file is removed by its own name, which no later holder has; what remains is
 * an empty directory, and both commands rename onto it, where one succeeds.
 * Neither step can touch the lock of a command that got in between. This does
 * not rest on "only one of two removals succeeds": on macOS two concurrent
 * `unlink` calls for one file both report success.
 */

import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

/** Who holds a lock, as written into it. */
export interface LockHolder {
	pid: number;
	host: string;
	/** When it was taken, ISO 8601. */
	since: string;
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
	 * Called when this command removes a lock whose holding process is gone,
	 * whether or not it then gets the lock itself: a lock is never removed
	 * without saying so. Two commands that find the same stale lock at the same
	 * moment may both report it.
	 */
	onStale?: (holder: LockHolder) => void;
	/** Whether a process of this machine still exists. Replaceable in tests. */
	isAlive?: (pid: number) => boolean;
	/** This machine's name. Replaceable in tests. */
	host?: string;
	/** How often to try while other commands keep getting in first. */
	attempts?: number;
}

const ATTEMPTS = 5;

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
 * when another command holds it.
 */
export async function acquireLock(
	lockPath: string,
	options: LockOptions = {}
): Promise<() => Promise<void>> {
	const host = options.host ?? hostname();
	const isAlive = options.isAlive ?? processIsAlive;
	const attempts = options.attempts ?? ATTEMPTS;

	// The lock as it will be, under a name only this command uses.
	const token = `${process.pid}.${randomBytes(6).toString("hex")}`;
	const prepared = `${lockPath}.${token}.taking`;
	const holderName = `${token}.json`;
	const holder: LockHolder = { pid: process.pid, host, since: new Date().toISOString() };
	await fs.mkdir(prepared, { mode: 0o700 });

	const report = options.onStale ?? (() => {});
	const reported: LockHolder[] = [];
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
				const found = await clearIfStale(lockPath, host, isAlive, report, reported);
				const denied = !found && (code === "EPERM" || code === "EACCES");
				notAllowed = denied && err instanceof Error ? err : undefined;
				continue;
			}
			return releaseOf(lockPath, holderName);
		}

		if (notAllowed) throw notAllowed;
		throw new LockHeldError(
			lockPath,
			undefined,
			`Other vaultore commands keep taking the lock ${lockPath}. It was left alone; try again in a moment`
		);
	} catch (err) {
		await fs.rm(prepared, { recursive: true, force: true });
		throw err;
	}
}

function releaseOf(lockPath: string, holderName: string): () => Promise<void> {
	let released = false;
	return async () => {
		if (released) return;
		released = true;
		await fs.rm(join(lockPath, holderName), { force: true });
		// Empty now, so nobody's. A command that renamed its own lock onto it in
		// the meantime made it non-empty, and then this removes nothing.
		await removeIfEmpty(lockPath);
	};
}

/**
 * Looks at what is at the lock's path. Removes a holder whose process is gone,
 * reporting it once, and an empty directory, and returns whether anything was
 * there. Throws LockHeldError for a lock that is held.
 */
async function clearIfStale(
	lockPath: string,
	host: string,
	isAlive: (pid: number) => boolean,
	report: (holder: LockHolder) => void,
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
				`${lockPath} is in the way and is not a vaultore lock. It was left alone; move it away if nothing needs it`
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
					"It was left alone; if no vaultore command is running, remove the lock"
			);
		}
		if (holder.host !== host) {
			throw new LockHeldError(
				lockPath,
				holder,
				`The lock ${lockPath} is held by process ${holder.pid} on ${holder.host}, since ${holder.since}. ` +
					"This machine cannot tell whether that process still runs. It was left alone; if it does not run, remove the lock"
			);
		}
		if (isAlive(holder.pid)) {
			throw new LockHeldError(
				lockPath,
				holder,
				`Another vaultore command holds the lock ${lockPath} (process ${holder.pid}, since ${holder.since}). ` +
					"It was left alone; try again when that command has finished"
			);
		}
		// Its process is gone. Removed by its own name, so this can never be the
		// file of a command that took the lock after this one looked.
		await fs.rm(file, { force: true });
		if (!reported.some((r) => r.pid === holder.pid && r.since === holder.since)) {
			reported.push(holder);
			report(holder);
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
		const { pid, host, since } = parsed as Record<string, unknown>;
		if (!Number.isInteger(pid) || typeof host !== "string" || typeof since !== "string") {
			return "unreadable";
		}
		return { pid: pid as number, host, since };
	} catch {
		return "unreadable";
	}
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
