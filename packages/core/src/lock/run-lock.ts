/**
 * @vaultore/core - one run per note, across the plugin and the CLI (#215)
 *
 * Every run of a note, started by hand or by a schedule, in Obsidian or by
 * `vaultore run` or `vaultore agent`, holds this note's run lock. A second
 * runner is refused and told who holds it.
 *
 * The locks live outside the vault, in one fixed directory per user:
 * `~/.config/vaultore/locks` (on Windows `%APPDATA%\vaultore\locks`). No flag
 * and no setting moves it, so both runners always meet there; sync cannot
 * deliver a lock and a cell, which sees only the vault, cannot forge or remove
 * one. The home directory is the account's, not `$HOME`.
 *
 * A lock is named after the note's real path: the vault's real path joined
 * with the note's, as the file system spells them. On macOS and Windows a note
 * reached as `notes/a.md` and as `Notes/A.md` is one file, and one lock.
 *
 * It cannot make two machines that share a synced vault safe: each has its own
 * locks. Nor runners in separate containers that share a lock directory: a
 * holder's process id means nothing outside its own container.
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { errorMessage } from "../errors";
import { LockHeldError, acquireLock, describeHolder } from "./index";
import type { LockHolder, LockOptions } from "./index";

/** The note is being run by another runner; it was left alone. */
export class RunLockHeldError extends Error {
	constructor(
		readonly notePath: string,
		readonly holder: LockHolder | undefined,
		message: string
	) {
		super(message);
		this.name = "RunLockHeldError";
	}
}

/**
 * The directory the run locks live in, for this user on this system. On
 * Windows `%APPDATA%`, which is the roaming profile and always set; elsewhere
 * the account's home directory, read from the user database and not from
 * `$HOME`, so an environment cannot move it.
 */
export function runLockDirectory(
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
	accountHome: () => string = () => userInfo().homedir
): string {
	return userStateDirectory("locks", "run locks", platform, env, accountHome);
}

/**
 * `<name>` in VaultOre's directory for this user, where both runners meet:
 * the run locks (`locks`) and the schedule record (`slots`). Found as
 * `runLockDirectory` describes; `what` names it in an error.
 */
export function userStateDirectory(
	name: string,
	what: string,
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
	accountHome: () => string = () => userInfo().homedir
): string {
	return join(userStateRoot(what, platform, env, accountHome), name);
}

/**
 * VaultOre's own folder for this user, which holds every `userStateDirectory`:
 * `~/.config/vaultore`, or `%APPDATA%\vaultore` on Windows. `what` names the
 * state looked for in an error.
 */
export function userStateRoot(
	what = "state",
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
	accountHome: () => string = () => userInfo().homedir
): string {
	if (platform === "win32") {
		const appData = env["APPDATA"];
		if (!appData) {
			throw new Error(`APPDATA is not set, so VaultOre cannot tell where its ${what} belong`);
		}
		return join(appData, "vaultore");
	}
	let home: string;
	try {
		home = accountHome();
	} catch (err) {
		// A process under a user id with no account, as a container may run
		// one: Node's userInfo() throws.
		throw new Error(
			`This process's user has no account with a home directory, so VaultOre cannot tell where its ${what} belong ` +
				`(${errorMessage(err)}). Run it as a user that has one`
		);
	}
	if (!home) {
		throw new Error(
			`This process's user has no home directory, so VaultOre cannot tell where its ${what} belong. Run it as a user that has one`
		);
	}
	return join(home, ".config", "vaultore");
}

/**
 * The key a note's run lock and schedule record are named after: the SHA-256
 * of its real path, the vault's real path joined with the note's, as the file
 * system spells them. The note must exist.
 */
export async function noteKey(vaultRoot: string, notePath: string): Promise<string> {
	const real = await fs.realpath(join(vaultRoot, notePath));
	return createHash("sha256").update(real.normalize("NFC")).digest("hex");
}

/**
 * The lock's path for the note at `notePath` (vault-relative, as
 * `resolveInVault` returns it) in the vault at `vaultRoot`. The note must
 * exist: its real path names the lock.
 */
export async function runLockPath(
	directory: string,
	vaultRoot: string,
	notePath: string
): Promise<string> {
	return join(directory, `${await noteKey(vaultRoot, notePath)}.lock`);
}

export interface RunLockOptions extends Pick<LockOptions, "isAlive" | "host" | "bootTime"> {
	vaultRoot: string;
	/** Vault-relative, as `resolveInVault` returns it. */
	notePath: string;
	/** Which runner takes it: "Obsidian", "vaultore run", "vaultore agent". */
	by: string;
	/** Told when a stale lock was removed; `why` completes "process <pid>, which took it at <since>, …". */
	onStale?: (holder: LockHolder, why: string) => void;
	/** Where the locks live. Default: `runLockDirectory()`. Tests pass their own. */
	directory?: string;
}

/** A stale holder that taking the lock removed, and why it was stale. */
export interface LeftBehind {
	holder: LockHolder;
	/** Completes "process <pid>, which took it at <since>, …". */
	why: string;
}

/** A note's run lock, held. */
export interface RunLock {
	/** Releases it; may be called more than once. */
	release(): Promise<void>;
	/**
	 * The holders of a lock left behind that were removed to take this one:
	 * runs of the note that ended without finishing. Usually none. When two
	 * runners find the same stale lock at once, the one that loses the race
	 * may be the one that removed it, and then the winner's list is empty.
	 */
	readonly leftBehind: readonly LeftBehind[];
}

/**
 * Takes the run lock of a note. Rejects with RunLockHeldError while another
 * run holds it.
 */
export async function acquireRunLock(options: RunLockOptions): Promise<RunLock> {
	const directory = options.directory ?? runLockDirectory();
	await fs.mkdir(directory, { recursive: true, mode: 0o700 });
	const lockPath = await runLockPath(directory, options.vaultRoot, options.notePath);
	const leftBehind: LeftBehind[] = [];
	try {
		const release = await acquireLock(lockPath, {
			by: options.by,
			isAlive: options.isAlive,
			host: options.host,
			bootTime: options.bootTime,
			onStale: (holder, why) => {
				leftBehind.push({ holder, why });
				options.onStale?.(holder, why);
			},
		});
		return { release, leftBehind };
	} catch (err) {
		if (!(err instanceof LockHeldError)) throw err;
		const holder = err.holder;
		const message = holder
			? `${options.notePath} is already being run by ${describeHolder(holder)}, since ${holder.since}. ` +
				`Nothing was run. If that process is not running VaultOre, remove ${lockPath}`
			: `${options.notePath} is not run: ${err.message}`;
		throw new RunLockHeldError(options.notePath, holder, message);
	}
}
