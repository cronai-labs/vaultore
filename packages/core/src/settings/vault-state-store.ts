import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, resolve } from "node:path";
import { errorMessage } from "../errors";
import { LockHeldError, acquireLockWaiting } from "../lock";
import type { LockHolder, LockOptions, LockWait } from "../lock";

/**
 * Per-vault state on this machine, outside the vault: one file in the user
 * tree holds every vault's entry, keyed by the vault's real path. What lives
 * here is consent a synced file must not grant (#171, #276): the schedule
 * approvals both runners read (`schedules.json`, #301).
 */

/** The file cannot be read, used or changed. The message names it. */
export class VaultStateStoreError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "VaultStateStoreError";
	}
}

export interface VaultStateStoreSpec<V> {
	/** The file, absolute. It need not exist: then every vault's entry is empty. */
	file: string;
	/** Written into the file and checked on reading. */
	format: string;
	version: number;
	/** What the file is, in messages: "approvals file". */
	what: string;
	/** Why a vault's stored entry is unusable, naming the vault, or undefined when it is fine. */
	invalid(entry: unknown, vault: string): string | undefined;
	/** A fresh, changeable copy of an entry; `undefined` gives the empty one. */
	copy(entry: V | undefined): V;
	/** An empty entry is not stored. */
	isEmpty(entry: V): boolean;
}

export interface VaultStateStoreOps {
	/** Puts the written temporary file in place. Replaceable in tests. */
	rename?: (from: string, to: string) => Promise<void>;
	/** How the lock around a change is taken. Replaceable in tests. */
	lock?: Pick<LockOptions, "isAlive" | "host" | "bootTime">;
	/** Told when a lock left by a process that is gone was removed. */
	onStaleLock?: (holder: LockHolder, lockPath: string, why: string) => void;
	/**
	 * How long a change waits while another process changes the file, before
	 * it is refused naming that process. Without it, it is refused at once.
	 */
	wait?: LockWait;
}

interface StateFile<V> {
	format: string;
	version: number;
	vaults: Record<string, V>;
	/** The files whose entries were copied in once (`importFrom`), so none is copied twice. */
	imported?: string[];
}

/**
 * The key a vault's entry is stored under: its real path, so a symbolic link
 * to the vault leads to the same entry.
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

export class VaultStateStore<V> {
	readonly file: string;
	private readonly rename: (from: string, to: string) => Promise<void>;
	private readonly lockOptions: Pick<LockOptions, "isAlive" | "host" | "bootTime">;
	private readonly onStaleLock: (holder: LockHolder, lockPath: string, why: string) => void;
	private readonly wait: LockWait | undefined;

	constructor(
		private readonly spec: VaultStateStoreSpec<V>,
		ops: VaultStateStoreOps = {}
	) {
		this.file = resolve(spec.file);
		this.rename = ops.rename ?? ((from, to) => fs.rename(from, to));
		this.lockOptions = ops.lock ?? {};
		this.onStaleLock = ops.onStaleLock ?? (() => {});
		this.wait = ops.wait;
	}

	/**
	 * One vault's entry. A missing file means an empty one; a file that cannot
	 * be read or is not this kind of file is an error, never "empty": a runner
	 * that carried on would act on nothing approved for a reason nobody sees,
	 * and a change that carried on would overwrite the file.
	 */
	async forVault(vaultKey: string): Promise<V> {
		const file = await this.read();
		return this.spec.copy(own(file.vaults, vaultKey));
	}

	/**
	 * Changes one vault's entry. `change` edits the copy it is given; the file
	 * is written only if that changed something. Returns whether it was written.
	 *
	 * Read, change and write happen under a lock, so two processes cannot each
	 * write what they read plus their own change. The new content goes to a
	 * temporary file that is renamed into place: a reader sees the old file or
	 * the new one, never part of one.
	 */
	async update(vaultKey: string, change: (entry: V) => void | Promise<void>): Promise<boolean> {
		await fs.mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
		const release = await this.lock();
		try {
			const file = await this.read();
			const before = JSON.stringify(file);

			const entry = this.spec.copy(own(file.vaults, vaultKey));
			await change(entry);

			const vaults: Record<string, V> = Object.assign(Object.create(null) as Record<string, V>, file.vaults);
			if (this.spec.isEmpty(entry)) {
				delete vaults[vaultKey];
			} else {
				vaults[vaultKey] = entry;
			}
			const next: StateFile<V> = {
				format: this.spec.format,
				version: this.spec.version,
				vaults,
				...(file.imported ? { imported: file.imported } : {}),
			};
			if (JSON.stringify(next) === before) return false;

			await this.write(next);
			return true;
		} finally {
			await release();
		}
	}

	/**
	 * Copies the entries of another file into this one, once per file: this
	 * file records the other's path when it copies it, decided under its lock,
	 * so a later call changes nothing, also after every copied entry was taken
	 * away again. `merge` adds what one vault's entry in the other file holds
	 * to that vault's entry here; it decides what an entry already here keeps.
	 * The other file is read and checked as its own store reads it, and left as
	 * it is. Returns whether anything was copied.
	 */
	async importFrom<W>(from: VaultStateStore<W>, merge: (into: V, entry: W) => void): Promise<boolean> {
		// Checked first without the lock, so that a command that only reads,
		// once the copy is done or when there is nothing to copy, creates no
		// folder and takes no lock; decided again under it.
		if (!(await exists(from.file)) || (await this.hasImported(from.file))) return false;
		await fs.mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
		const release = await this.lock();
		try {
			const file = await this.read();
			if (file.imported?.includes(from.file)) return false;
			if (!(await exists(from.file))) return false;
			const source = await from.readVaults();
			const vaults: Record<string, V> = Object.assign(Object.create(null) as Record<string, V>, file.vaults);
			for (const [vault, entry] of Object.entries(source)) {
				const into = this.spec.copy(own(vaults, vault));
				merge(into, entry);
				if (this.spec.isEmpty(into)) delete vaults[vault];
				else vaults[vault] = into;
			}
			await this.write({
				format: this.spec.format,
				version: this.spec.version,
				vaults,
				imported: [...(file.imported ?? []), from.file],
			});
			return true;
		} finally {
			await release();
		}
	}

	/** Every vault's entry, as checked when read. */
	async readVaults(): Promise<Record<string, V>> {
		return (await this.read()).vaults;
	}

	private async hasImported(path: string): Promise<boolean> {
		return (await this.read()).imported?.includes(path) ?? false;
	}

	private async read(): Promise<StateFile<V>> {
		let text: string;
		try {
			text = await fs.readFile(this.file, "utf8");
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") {
				return { format: this.spec.format, version: this.spec.version, vaults: {} };
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

	private validated(parsed: unknown): StateFile<V> {
		if (!isRecord(parsed) || parsed["format"] !== this.spec.format) {
			throw this.unusable(`it is not a VaultOre ${this.spec.what}`);
		}
		if (parsed["version"] !== this.spec.version) {
			throw this.unusable(
				`it has version ${JSON.stringify(parsed["version"])}, and this VaultOre reads version ${this.spec.version}`
			);
		}
		const vaults = parsed["vaults"];
		if (!isRecord(vaults)) throw this.unusable("it has no list of vaults");
		const imported = parsed["imported"];
		if (imported !== undefined && (!Array.isArray(imported) || !imported.every((item) => typeof item === "string"))) {
			throw this.unusable("its list of imported files is not a list of paths");
		}
		for (const [vault, entry] of Object.entries(vaults)) {
			const reason = this.spec.invalid(entry, vault);
			if (reason !== undefined) throw this.unusable(reason);
		}
		return parsed as unknown as StateFile<V>;
	}

	private unusable(reason: string): VaultStateStoreError {
		return new VaultStateStoreError(
			`Cannot use the ${this.spec.what} ${this.file}: ${reason}. It was left as it is; repair or remove it`
		);
	}

	private async write(file: StateFile<V>): Promise<void> {
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
	 * process that is gone is taken over and reported (`acquireLock`).
	 */
	private async lock(): Promise<() => Promise<void>> {
		const lockPath = `${this.file}.lock`;
		try {
			return await acquireLockWaiting(lockPath, {
				...this.lockOptions,
				onStale: (holder, why) => this.onStaleLock(holder, lockPath, why),
				wait: this.wait,
			});
		} catch (err) {
			if (err instanceof LockHeldError) throw new VaultStateStoreError(err.message);
			throw err;
		}
	}
}

async function exists(path: string): Promise<boolean> {
	try {
		await fs.lstat(path);
		return true;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw err;
	}
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An own property only: a key is text from outside, and "constructor" is not an entry. */
export function own<T>(record: Record<string, T>, key: string): T | undefined {
	return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}
