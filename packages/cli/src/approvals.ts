/**
 * @vaultore/cli - where the agent's schedule approvals are kept
 *
 * `vaultore agent` runs a scheduled note only while an approval for it exists
 * (#116). The approvals are kept outside the vault, on this machine: whatever
 * is inside a vault can arrive through sync, and consent must not be something
 * a synced file can grant. One file holds every vault's approvals, keyed by
 * the vault's real path.
 *
 * What an approval is, and whether a note still has it, is core's
 * (`classifyScheduleApproval`); this file only reads and writes the list.
 */

import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { posix, resolve, win32 } from "node:path";
import { errorMessage } from "@vaultore/core";
import type { ScheduleApproval } from "@vaultore/core";
import { LockHeldError, acquireLock } from "./lock";
import type { LockHolder, LockOptions } from "./lock";

const APPROVALS_FILE = "approvals.json";
const FORMAT = "vaultore.schedule-approvals";
const VERSION = 1;

/** A vault's approvals: vault-relative note path to approval. */
export type VaultApprovals = Record<string, ScheduleApproval>;

interface ApprovalsFile {
	format: typeof FORMAT;
	version: typeof VERSION;
	/** The vault's real path to its approvals. */
	vaults: Record<string, VaultApprovals>;
}

/** The approvals file cannot be read, used or changed. The message names it. */
export class ApprovalStoreError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ApprovalStoreError";
	}
}

// =============================================================================
// WHERE
// =============================================================================

export interface StateDirInputs {
	/** The value of `--state-dir`, when given. */
	flag?: string | boolean;
	env: Readonly<Record<string, string | undefined>>;
	platform: NodeJS.Platform;
	homedir: string;
}

/**
 * The folder VaultOre keeps this machine's own state in:
 * `--state-dir`, else `%APPDATA%\vaultore` on Windows, else
 * `$XDG_CONFIG_HOME/vaultore`, else `~/.config/vaultore`.
 *
 * A relative or empty `XDG_CONFIG_HOME` is ignored, as the XDG base directory
 * specification says: taken as is, the approvals would move with the directory
 * the command runs in.
 */
export function resolveStateDir(inputs: StateDirInputs): string {
	const { flag, env, platform, homedir } = inputs;

	if (flag !== undefined) {
		if (typeof flag !== "string" || flag.trim() === "") {
			throw new Error("--state-dir requires a value");
		}
		return resolve(flag);
	}

	if (platform === "win32") {
		const appData = env["APPDATA"];
		if (!appData) {
			throw new Error("APPDATA is not set, so there is no place for approvals: pass --state-dir <dir>");
		}
		return win32.join(appData, "vaultore");
	}

	const xdg = env["XDG_CONFIG_HOME"];
	if (xdg && posix.isAbsolute(xdg)) return posix.join(xdg, "vaultore");
	if (!homedir) {
		throw new Error("No home directory, so there is no place for approvals: pass --state-dir <dir>");
	}
	return posix.join(homedir, ".config", "vaultore");
}

/**
 * The key a vault's approvals are stored under: its real path, so a symbolic
 * link to the vault leads to the same approvals.
 */
export async function vaultKeyFor(vaultRoot: string): Promise<string> {
	try {
		return await fs.realpath(vaultRoot);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			throw new Error(`The vault ${vaultRoot} does not exist`);
		}
		throw err;
	}
}

// =============================================================================
// THE FILE
// =============================================================================

export interface ApprovalStoreOps {
	/** Puts the written temporary file in place. Replaceable in tests. */
	rename?: (from: string, to: string) => Promise<void>;
	/** How the lock around a change is taken. Replaceable in tests. */
	lock?: Pick<LockOptions, "isAlive" | "host">;
	/** Told when a lock left by a command that is gone was removed. Default: a line on stderr. */
	onStaleLock?: (holder: LockHolder, lockPath: string) => void;
}

export class ApprovalStore {
	/** The approvals file. It need not exist: then nothing is approved. */
	readonly file: string;
	private readonly dir: string;
	private readonly rename: (from: string, to: string) => Promise<void>;
	private readonly lockOptions: Pick<LockOptions, "isAlive" | "host">;
	private readonly onStaleLock: (holder: LockHolder, lockPath: string) => void;

	constructor(stateDir: string, ops: ApprovalStoreOps = {}) {
		this.dir = resolve(stateDir);
		this.file = resolve(this.dir, APPROVALS_FILE);
		this.rename = ops.rename ?? ((from, to) => fs.rename(from, to));
		this.lockOptions = ops.lock ?? {};
		this.onStaleLock =
			ops.onStaleLock ??
			((holder, lockPath) => {
				process.stderr.write(
					`[vaultore] removed the lock ${lockPath}: process ${holder.pid}, which took it at ${holder.since}, is no longer running\n`
				);
			});
	}

	/**
	 * The approvals of one vault. A missing file means none; a file that cannot
	 * be read or is not an approvals file is an error, never "none": an agent
	 * that carried on would report nothing approved for a reason nobody sees,
	 * and a command that carried on would overwrite the file.
	 */
	async forVault(vaultKey: string): Promise<VaultApprovals> {
		const file = await this.read();
		return own(file.vaults, vaultKey) ?? {};
	}

	/**
	 * Change one vault's approvals. `change` edits the map it is given; the file
	 * is written only if that changed something. Returns whether it was written.
	 *
	 * Read, change and write happen under a lock, so two commands cannot
	 * each write what they read plus their own change. The new content goes to
	 * a temporary file that is renamed into place: a reader sees the old file or
	 * the new one, never part of one.
	 */
	async update(
		vaultKey: string,
		change: (approvals: VaultApprovals) => void | Promise<void>
	): Promise<boolean> {
		await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
		const release = await this.lock();
		try {
			const file = await this.read();
			const before = JSON.stringify(file);

			// Without a prototype, so that a note path such as "__proto__" is stored
			// as an entry like any other.
			const approvals: VaultApprovals = Object.assign(
				Object.create(null) as VaultApprovals,
				own(file.vaults, vaultKey)
			);
			await change(approvals);

			const vaults: Record<string, VaultApprovals> = Object.assign(
				Object.create(null) as Record<string, VaultApprovals>,
				file.vaults
			);
			if (Object.keys(approvals).length > 0) {
				vaults[vaultKey] = approvals;
			} else {
				delete vaults[vaultKey];
			}
			const next: ApprovalsFile = { format: FORMAT, version: VERSION, vaults };
			if (JSON.stringify(next) === before) return false;

			await this.write(next);
			return true;
		} finally {
			await release();
		}
	}

	private async read(): Promise<ApprovalsFile> {
		let text: string;
		try {
			text = await fs.readFile(this.file, "utf8");
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") {
				return { format: FORMAT, version: VERSION, vaults: {} };
			}
			throw this.unusable(errorMessage(err));
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch (err) {
			throw this.unusable(`it is not JSON (${errorMessage(err)})`);
		}
		return this.validated(parsed);
	}

	private validated(parsed: unknown): ApprovalsFile {
		if (!isRecord(parsed) || parsed["format"] !== FORMAT) {
			throw this.unusable("it is not a VaultOre approvals file");
		}
		if (parsed["version"] !== VERSION) {
			throw this.unusable(
				`it has version ${JSON.stringify(parsed["version"])}, and this vaultore reads version ${VERSION}`
			);
		}
		const vaults = parsed["vaults"];
		if (!isRecord(vaults)) throw this.unusable("it has no list of vaults");

		for (const [vault, approvals] of Object.entries(vaults)) {
			if (!isRecord(approvals)) throw this.unusable(`the entry for vault ${vault} is not a list`);
			for (const [path, approval] of Object.entries(approvals)) {
				if (
					!isRecord(approval) ||
					typeof approval["hash"] !== "string" ||
					typeof approval["schedule"] !== "string" ||
					typeof approval["approvedAt"] !== "string"
				) {
					throw this.unusable(`the approval of ${path} in vault ${vault} is incomplete`);
				}
			}
		}
		return parsed as unknown as ApprovalsFile;
	}

	private unusable(reason: string): ApprovalStoreError {
		return new ApprovalStoreError(
			`Cannot use the approvals file ${this.file}: ${reason}. It was left as it is; repair or remove it`
		);
	}

	private async write(file: ApprovalsFile): Promise<void> {
		const temporary = `${this.file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
		try {
			await fs.writeFile(temporary, JSON.stringify(file, null, 2) + "\n", {
				encoding: "utf8",
				mode: 0o600,
				flag: "wx",
			});
			await this.rename(temporary, this.file);
		} catch (err) {
			await fs.rm(temporary, { force: true });
			throw err;
		}
	}

	/**
	 * Takes the lock around a change, or says who holds it. A lock left by a
	 * command that is gone is taken over and reported (`acquireLock`).
	 */
	private async lock(): Promise<() => Promise<void>> {
		const lockPath = `${this.file}.lock`;
		try {
			return await acquireLock(lockPath, {
				...this.lockOptions,
				onStale: (holder) => this.onStaleLock(holder, lockPath),
			});
		} catch (err) {
			if (err instanceof LockHeldError) throw new ApprovalStoreError(err.message);
			throw err;
		}
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An own property only: a key is text from outside, and "constructor" is not an entry. */
function own<T>(record: Record<string, T>, key: string): T | undefined {
	return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}
