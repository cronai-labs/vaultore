/**
 * @vaultore/core - the schedule record: each scheduled slot runs at most once (#255)
 *
 * A note scheduled in the plugin and in `vaultore agent` is fired by both. The
 * run lock keeps the runs apart, not from following each other; this record
 * lets only the first runner that claims a slot, one occurrence of a note's
 * schedule, run it, and keeps what each slot came to. The model, its states
 * and invariants: specs/schedule-record-spec.md.
 *
 * Layout, beside the run locks: `<directory>/<note key>/<slot>.claim.json` and
 * `<slot>.outcome.json`, where the note key is the run lock's and the slot is
 * named like `20261124T101500000Z`. A claim is written under a name of its own
 * and hard-linked to its place, which fails when a claim is there: exactly one
 * runner gets it, and a claim is never seen half-written. Only the claimer
 * writes the outcome, through a temporary file and a rename.
 */

import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { describeHolder, holderGoneBecause } from "../lock";
import type { LockHolder, LockOptions } from "../lock";
import { noteKey, userStateDirectory } from "../lock/run-lock";

/** History is kept at most this long, whatever a runner's setting says. */
export const MAX_KEEP_DAYS = 30;
/**
 * A slot's files are kept at least this long, also with the history switched
 * off: a runner whose machine slept fires the slot it missed once it wakes, and
 * the claim must still be there to stop it.
 */
export const MIN_KEEP_MS = 24 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;
const RECORD_VERSION = 1;

/** The directory of the schedule record for this user on this system. */
export function slotRecordDirectory(
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
	accountHome?: () => string
): string {
	return userStateDirectory("slots", "schedule record", platform, env, accountHome);
}

/** A slot's name: its instant in UTC, in a form every file system accepts. */
export function slotName(slot: Date): string {
	return slot.toISOString().replace(/[-:.]/g, "");
}

/** The instant a slot's name stands for, or undefined for another name. */
export function slotFromName(name: string): Date | undefined {
	const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z$/.exec(name);
	if (!match) return undefined;
	const [, y, mo, d, h, mi, s, ms] = match;
	const date = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}.${ms}Z`);
	return Number.isNaN(date.getTime()) ? undefined : date;
}

/** What a claim records: whose slot this is. */
export interface SlotClaimRecord extends LockHolder {
	version: number;
	/** The vault's real path. */
	vault: string;
	/** The note, vault-relative. */
	note: string;
	schedule: string;
	/** The slot, ISO 8601. */
	slot: string;
	/** This claim's own name, by which the claiming process knows its run goes on. */
	token: string;
}

/** What a scheduled run came to. `skipped`: nothing ran (the note was locked, or changed). */
export type SlotResult = "completed" | "failed" | "aborted" | "skipped";

export interface SlotOutcome {
	result: SlotResult;
	/** Why it failed, aborted or was skipped. */
	reason?: string;
	/** The run's id, when a run started. */
	runId?: string;
}

interface SlotOutcomeRecord extends SlotOutcome {
	version: number;
	/** ISO 8601. */
	finishedAt: string;
}

/** A slot this runner claimed: it runs the note, then says how that ended. */
export interface SlotClaim {
	readonly slot: Date;
	/** Writes the outcome; a second call changes nothing. */
	finish(outcome: SlotOutcome): Promise<void>;
}

/** Another runner claimed the slot first; this one must not run it. */
export class SlotTakenError extends Error {
	constructor(
		readonly notePath: string,
		readonly slot: Date,
		readonly claim: SlotClaimRecord | undefined,
		message: string
	) {
		super(message);
		this.name = "SlotTakenError";
	}
}

export interface ClaimSlotOptions extends Pick<LockOptions, "host"> {
	vaultRoot: string;
	/** Vault-relative, as `resolveInVault` returns it. The note must exist. */
	notePath: string;
	schedule: string;
	slot: Date;
	/** Which runner claims it: "Obsidian", "vaultore agent". */
	by: string;
	/** Days of history to keep, 0 to 30; the runner's setting. Default 30. */
	keepDays?: number;
	/** Where the record lives. Default: `slotRecordDirectory()`. Tests pass their own. */
	directory?: string;
	/** The clock, for pruning. Default: now. */
	now?: Date;
	/** Told about a file pruning could not remove; pruning never fails a claim. */
	onPruneError?: (path: string, error: unknown) => void;
}

/**
 * The tokens of this process's claims whose run has not ended. Kept on
 * `process`, as the held locks are; by token, not by file, so a second claim
 * of the same slot that loses cannot unmark the first.
 */
const OPEN = Symbol.for("vaultore.slots.open");

function openClaims(): Set<string> {
	const slot = process as unknown as Record<symbol, Set<string> | undefined>;
	let open = slot[OPEN];
	if (!open) {
		open = new Set<string>();
		slot[OPEN] = open;
	}
	return open;
}

function codeOf(err: unknown): string | undefined {
	return typeof err === "object" && err !== null && "code" in err ? String(err.code) : undefined;
}

/**
 * Claims a slot of a note for this runner. Rejects with SlotTakenError when a
 * runner claimed it first. Prunes the record afterwards, by `keepDays`.
 */
export async function claimSlot(options: ClaimSlotOptions): Promise<SlotClaim> {
	const directory = options.directory ?? slotRecordDirectory();
	const noteDir = join(directory, await noteKey(options.vaultRoot, options.notePath));
	await fs.mkdir(noteDir, { recursive: true, mode: 0o700 });

	const name = slotName(options.slot);
	const claimPath = join(noteDir, `${name}.claim.json`);
	const token = `${process.pid}.${randomBytes(6).toString("hex")}`;
	const record: SlotClaimRecord = {
		version: RECORD_VERSION,
		vault: await fs.realpath(options.vaultRoot),
		note: options.notePath,
		schedule: options.schedule,
		slot: options.slot.toISOString(),
		pid: process.pid,
		host: options.host ?? hostname(),
		since: new Date().toISOString(),
		by: options.by,
		token,
	};

	const open = openClaims();
	// Recorded before the link can make it visible: pruning in this process
	// would otherwise judge it left behind.
	open.add(token);
	try {
		await writeExclusive(claimPath, JSON.stringify(record) + "\n");
	} catch (err) {
		open.delete(token);
		if (codeOf(err) !== "EEXIST") throw err;
		const holder = await readJson<SlotClaimRecord>(claimPath);
		const who = holder ? `${describeHolder(holder)}, at ${holder.since}` : "another runner";
		throw new SlotTakenError(
			options.notePath,
			options.slot,
			holder,
			`The ${options.slot.toISOString()} run of ${options.notePath} was claimed by ${who}. Nothing was run`
		);
	}

	await pruneSlotRecord({
		directory,
		keepDays: options.keepDays,
		now: options.now,
		host: options.host,
		onError: options.onPruneError,
	});

	let finished = false;
	return {
		slot: options.slot,
		async finish(outcome) {
			if (finished) return;
			finished = true;
			const outcomeRecord: SlotOutcomeRecord = {
				version: RECORD_VERSION,
				...outcome,
				finishedAt: new Date().toISOString(),
			};
			try {
				await writeReplacing(join(noteDir, `${name}.outcome.json`), JSON.stringify(outcomeRecord) + "\n");
			} finally {
				open.delete(token);
			}
		},
	};
}

/** Writes `path` whole, or fails with EEXIST when something is there. */
async function writeExclusive(path: string, content: string): Promise<void> {
	const prepared = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
	await fs.writeFile(prepared, content, { flag: "wx", mode: 0o600 });
	try {
		await fs.link(prepared, path);
	} finally {
		await fs.rm(prepared, { force: true });
	}
}

/** Writes `path` whole, replacing what is there. */
async function writeReplacing(path: string, content: string): Promise<void> {
	const prepared = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
	await fs.writeFile(prepared, content, { flag: "wx", mode: 0o600 });
	try {
		await fs.rename(prepared, path);
	} catch (err) {
		await fs.rm(prepared, { force: true });
		throw err;
	}
}

async function readJson<T>(path: string): Promise<T | undefined> {
	try {
		return JSON.parse(await fs.readFile(path, "utf8")) as T;
	} catch {
		return undefined;
	}
}

/** One slot as the record shows it. */
export interface SlotEntry {
	/** The note, vault-relative, as its claim names it. */
	note: string;
	/** The vault's real path, as its claim names it. */
	vault: string;
	schedule: string;
	slot: Date;
	/** `running`: claimed, its run not ended; `abandoned`: claimed by a runner that is gone. */
	state: SlotResult | "running" | "abandoned";
	claimedBy: SlotClaimRecord;
	reason?: string;
	runId?: string;
	finishedAt?: string;
}

export interface ReadSlotRecordOptions extends Pick<LockOptions, "isAlive" | "host" | "bootTime"> {
	directory?: string;
	/** Only this vault's slots. */
	vaultRoot?: string;
	/** Only this note's, vault-relative. */
	notePath?: string;
}

/** The slots in the record, oldest first. Unreadable files are left out. */
export async function readSlotRecord(options: ReadSlotRecordOptions = {}): Promise<SlotEntry[]> {
	const directory = options.directory ?? slotRecordDirectory();
	const vault = options.vaultRoot === undefined ? undefined : await fs.realpath(options.vaultRoot);
	const entries: SlotEntry[] = [];
	for (const noteDir of await listDirectory(directory)) {
		const dir = join(directory, noteDir);
		for (const file of await listDirectory(dir)) {
			const name = file.endsWith(".claim.json") ? file.slice(0, -".claim.json".length) : undefined;
			const slot = name === undefined ? undefined : slotFromName(name);
			if (name === undefined || slot === undefined) continue;
			const claim = await readJson<SlotClaimRecord>(join(dir, file));
			if (!claim || typeof claim.note !== "string" || typeof claim.vault !== "string") continue;
			if (vault !== undefined && claim.vault !== vault) continue;
			if (options.notePath !== undefined && claim.note !== options.notePath) continue;
			const outcome = await readJson<SlotOutcomeRecord>(join(dir, `${name}.outcome.json`));
			const gone = outcome ? undefined : claimGoneBecause(claim, options);
			entries.push({
				note: claim.note,
				vault: claim.vault,
				schedule: claim.schedule,
				slot,
				state: outcome ? outcome.result : gone ? "abandoned" : "running",
				claimedBy: claim,
				...(outcome?.reason !== undefined ? { reason: outcome.reason } : {}),
				...(gone !== undefined ? { reason: `the runner ${gone}` } : {}),
				...(outcome?.runId !== undefined ? { runId: outcome.runId } : {}),
				...(outcome?.finishedAt !== undefined ? { finishedAt: outcome.finishedAt } : {}),
			});
		}
	}
	return entries.sort((a, b) => a.slot.getTime() - b.slot.getTime() || a.note.localeCompare(b.note));
}

/** Why a claim with no outcome is abandoned; undefined while its run may go on. */
function claimGoneBecause(
	claim: SlotClaimRecord,
	options: Pick<LockOptions, "isAlive" | "host" | "bootTime">
): string | undefined {
	if (claim.pid === process.pid && openClaims().has(claim.token)) return undefined;
	return holderGoneBecause(claim, options);
}

async function listDirectory(path: string): Promise<string[]> {
	try {
		return await fs.readdir(path);
	} catch (err) {
		if (codeOf(err) === "ENOENT") return [];
		throw err;
	}
}

export interface PruneOptions extends Pick<LockOptions, "isAlive" | "host" | "bootTime"> {
	directory?: string;
	/** Days of history to keep, 0 to 30. Default 30. */
	keepDays?: number;
	now?: Date;
	onError?: (path: string, error: unknown) => void;
}

/** How long a slot's files are kept for a `keepDays` setting. */
export function keepMilliseconds(keepDays: number = MAX_KEEP_DAYS): number {
	const days = Number.isFinite(keepDays) ? Math.min(Math.max(keepDays, 0), MAX_KEEP_DAYS) : MAX_KEEP_DAYS;
	return Math.max(days * DAY_MS, MIN_KEEP_MS);
}

/**
 * Removes the files of slots older than the history kept, and temporary files
 * left by a killed writer. A claim whose run may still go on is kept. Returns
 * how many slots were removed; a file it cannot remove is reported and left.
 */
export async function pruneSlotRecord(options: PruneOptions = {}): Promise<number> {
	const directory = options.directory ?? slotRecordDirectory();
	const cutoff = (options.now ?? new Date()).getTime() - keepMilliseconds(options.keepDays);
	const report = options.onError ?? (() => {});
	let removed = 0;
	for (const noteDir of await listDirectory(directory)) {
		const dir = join(directory, noteDir);
		let files: string[];
		try {
			files = await listDirectory(dir);
		} catch (err) {
			report(dir, err);
			continue;
		}
		for (const file of files) {
			const path = join(dir, file);
			try {
				if (file.endsWith(".tmp")) {
					const stat = await fs.stat(path);
					if (stat.mtimeMs < cutoff) await fs.rm(path, { force: true });
					continue;
				}
				if (!file.endsWith(".claim.json")) continue;
				const name = file.slice(0, -".claim.json".length);
				const slot = slotFromName(name);
				if (slot === undefined || slot.getTime() >= cutoff) continue;
				const outcomePath = join(dir, `${name}.outcome.json`);
				const hasOutcome = (await readJson<SlotOutcomeRecord>(outcomePath)) !== undefined;
				if (!hasOutcome) {
					const claim = await readJson<SlotClaimRecord>(path);
					if (claim && claimGoneBecause(claim, options) === undefined) continue;
				}
				await fs.rm(outcomePath, { force: true });
				await fs.rm(path, { force: true });
				removed += 1;
			} catch (err) {
				report(path, err);
			}
		}
		try {
			await fs.rmdir(dir);
		} catch (err) {
			if (codeOf(err) !== "ENOTEMPTY" && codeOf(err) !== "EEXIST" && codeOf(err) !== "ENOENT") report(dir, err);
		}
	}
	return removed;
}

/** "completed", "skipped: …", for a line of the log. */
export function describeSlotState(entry: SlotEntry): string {
	return entry.reason ? `${entry.state}: ${entry.reason}` : entry.state;
}

