import { createHash, randomBytes } from "node:crypto";
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
	/**
	 * The files copied in, as written before the marker beside the file
	 * (#309): still honoured, no longer written.
	 */
	imported?: string[];
}

/**
 * What was copied in, kept beside the file it was copied into
 * (`<file>.imports.json`), so that removing that file does not copy it in
 * again (#309). Each source with the SHA-256 of what was copied, and of the
 * last changed copy that was reported.
 */
interface ImportMarker {
	format: "vaultore.imports";
	version: 1;
	imports: ImportRecord[];
}

interface ImportRecord {
	from: string;
	sha256: string;
	importedAt: string;
	reported?: string;
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
	 * Copies the entries of another file into this one, once per file. The
	 * copy is recorded in a marker beside this file, with the other file's
	 * SHA-256, before anything is copied: removing this file does not copy it
	 * in again, and a copy cut short leaves it not copied rather than copied
	 * twice (#309). A file that changed since it was copied is not copied
	 * again: `onChanged` is told, once per change. Decided under this file's
	 * lock. `merge` adds what one vault's entry in the other file holds to
	 * that vault's entry here; it decides what an entry already here keeps.
	 * The other file is read and checked as its own store reads it, and left
	 * as it is. Returns whether anything was copied.
	 */
	async importFrom<W>(
		from: VaultStateStore<W>,
		merge: (into: V, entry: W) => void,
		onChanged?: (file: string) => void
	): Promise<boolean> {
		// Checked first without the lock, so that a command that only reads,
		// once the copy is done or when there is nothing to copy, creates no
		// folder and takes no lock; decided again under it.
		const before = await sha256Of(from.file);
		if (before === undefined) return false;
		const known = (await this.readMarker()).imports.find((record) => record.from === from.file);
		if (known !== undefined && (known.sha256 === before || known.reported === before)) return false;
		await fs.mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
		const release = await this.lock();
		try {
			const sha256 = await sha256Of(from.file);
			if (sha256 === undefined) return false;
			const marker = await this.readMarker();
			const record = marker.imports.find((entry) => entry.from === from.file);
			if (record !== undefined) {
				if (record.sha256 === sha256 || record.reported === sha256) return false;
				record.reported = sha256;
				await this.writeMarker(marker);
				onChanged?.(from.file);
				return false;
			}
			const file = await this.read();
			marker.imports.push({ from: from.file, sha256, importedAt: new Date().toISOString() });
			await this.writeMarker(marker);
			// Copied before the marker existed: the marker now says so.
			if (file.imported?.includes(from.file)) return false;
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
				...(file.imported ? { imported: file.imported } : {}),
			});
			return true;
		} finally {
			await release();
		}
	}

	/** The marker of what was copied in, beside the file. */
	get markerFile(): string {
		return `${this.file}.imports.json`;
	}

	private async readMarker(): Promise<ImportMarker> {
		let text: string;
		try {
			text = await fs.readFile(this.markerFile, "utf8");
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return { format: "vaultore.imports", version: 1, imports: [] };
			throw this.unusableMarker(errorMessage(err));
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch (err) {
			throw this.unusableMarker(`it is not JSON (${errorMessage(err)})`);
		}
		if (!isRecord(parsed) || parsed["format"] !== "vaultore.imports" || parsed["version"] !== 1 || !Array.isArray(parsed["imports"])) {
			throw this.unusableMarker("it is not a VaultOre import marker of version 1");
		}
		for (const record of parsed["imports"] as unknown[]) {
			if (
				!isRecord(record) ||
				typeof record["from"] !== "string" ||
				typeof record["sha256"] !== "string" ||
				typeof record["importedAt"] !== "string" ||
				(record["reported"] !== undefined && typeof record["reported"] !== "string")
			) {
				throw this.unusableMarker("one of its records is incomplete");
			}
		}
		return parsed as unknown as ImportMarker;
	}

	private unusableMarker(reason: string): VaultStateStoreError {
		return new VaultStateStoreError(
			`Cannot use ${this.markerFile}, which records what was copied into ${this.file}: ${reason}. ` +
				"It was left as it is; repair or remove it"
		);
	}

	private async writeMarker(marker: ImportMarker): Promise<void> {
		await writeAtomically(this.markerFile, JSON.stringify(marker, null, 2) + "\n", this.rename);
	}

	/** Every vault's entry, as checked when read. */
	async readVaults(): Promise<Record<string, V>> {
		return (await this.read()).vaults;
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
		await writeAtomically(this.file, JSON.stringify(file, null, 2) + "\n", this.rename);
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

/** Writes a temporary file beside `path` and renames it into place. */
async function writeAtomically(path: string, text: string, rename: (from: string, to: string) => Promise<void>): Promise<void> {
	const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
	try {
		await fs.writeFile(temporary, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
		await rename(temporary, path);
	} catch (err) {
		await fs.rm(temporary, { force: true });
		throw err;
	}
}

/** The SHA-256 of a file's bytes, or undefined when there is no file. */
async function sha256Of(path: string): Promise<string | undefined> {
	try {
		return createHash("sha256").update(await fs.readFile(path)).digest("hex");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
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
