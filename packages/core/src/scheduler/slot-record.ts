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

import { CronExpressionParser } from "cron-parser";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { describeHolder, holderGoneBecause } from "../lock";
import type { LockHolder, LockOptions } from "../lock";
import { noteKey, userStateDirectory } from "../lock/run-lock";
import { LATE_AFTER_MS } from "./index";

/** History is kept at most this long, whatever a runner's setting says. */
export const MAX_KEEP_DAYS = 30;
/**
 * A slot's files are kept at least this long, also with the history switched
 * off: a runner whose machine slept fires the slot it missed once it wakes, and
 * the claim must still be there to stop it.
 */
export const MIN_KEEP_MS = 24 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

export { LATE_AFTER_MS };
/**
 * A gap covers only slots older than the late threshold: those no runner may
 * claim any more, as a tick that reaches them is late. The scheduler fires
 * every younger one, so between the two nothing is left undecided. Default.
 */
export const GAP_MARGIN_MS = LATE_AFTER_MS;
/** The most slots one gap records; a longer run of missed slots becomes several gaps. */
const MAX_GAP_SLOTS = 50_000;
/** How often a runner prunes the record, at most, when it claims. */
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
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

/**
 * What a slot's decision file records: whose slot this is. The file is the
 * slot's one decision, so it also carries how the slot was decided: today
 * always `claimed`; missed slots (#269) will be decided as `missed` in the
 * same file, which keeps a slot from being both. A reader meets kinds and
 * versions it does not know as decided, never as open.
 */
export interface SlotClaimRecord extends LockHolder {
	version: number;
	kind: "claimed";
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

/** A gap: slots of a note that no runner fired, decided at once (#269). */
export interface SlotMissedRecord extends Omit<SlotClaimRecord, "kind"> {
	kind: "missed";
	/** The gap's last slot, ISO 8601; `slot` is its first. */
	until: string;
	/** How many slots the gap holds. */
	count: number;
}

/** A slot's one decision: claimed by a runner, or missed. */
export type SlotDecisionRecord = SlotClaimRecord | SlotMissedRecord;

/** How the user resolved a gap; a catch-up then writes the outcome. */
export interface SlotResolutionRecord extends LockHolder {
	version: number;
	kind: "dismissed" | "caught-up";
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
	/** Prune at most this often per directory in this process. Default an hour; tests pass 0. */
	pruneIntervalMs?: number;
}

/** When this process last pruned each record directory. Kept on `process`, as the open claims are. */
const PRUNED = Symbol.for("vaultore.slots.pruned");

function lastPruned(): Map<string, number> {
	const slot = process as unknown as Record<symbol, Map<string, number> | undefined>;
	let pruned = slot[PRUNED];
	if (!pruned) {
		pruned = new Map<string, number>();
		slot[PRUNED] = pruned;
	}
	return pruned;
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
		kind: "claimed",
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

	// Every claim would read the whole record; once an hour is enough to keep
	// it within the history.
	const pruned = lastPruned();
	const now = Date.now();
	if (now - (pruned.get(directory) ?? 0) >= (options.pruneIntervalMs ?? PRUNE_INTERVAL_MS)) {
		pruned.set(directory, now);
		await pruneSlotRecord({
			directory,
			keepDays: options.keepDays,
			now: options.now,
			host: options.host,
			onError: options.onPruneError,
		});
	}

	return outcomeWriter(noteDir, name, options.slot, token);
}

/** The claim a run finishes: it writes the slot's outcome once and unmarks the token. */
function outcomeWriter(noteDir: string, name: string, slot: Date, token: string): SlotClaim {
	const open = openClaims();
	let finished = false;
	return {
		slot,
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
	/**
	 * `running`: claimed (or caught up), its run not ended; `abandoned`: its
	 * runner is gone; `missed`: a gap not resolved yet; `dismissed`: a gap the
	 * user dismissed; `unknown`: decided by a newer VaultOre, as the reason says.
	 */
	state: SlotResult | "running" | "abandoned" | "missed" | "dismissed" | "unknown";
	/** How the slot was decided: claimed by a runner, or missed (a gap). */
	kind: "claimed" | "missed" | "unknown";
	/** Who decided it: the claimer, or the runner that found the gap. */
	claimedBy: SlotDecisionRecord;
	/** A gap's last slot and size. */
	until?: Date;
	count?: number;
	/** Who dismissed or caught up a gap. */
	resolvedBy?: SlotResolutionRecord;
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
	for (const noteDir of await listNoteDirectories(directory)) {
		const dir = join(directory, noteDir);
		for (const file of await listDirectory(dir)) {
			const name = file.endsWith(".claim.json") ? file.slice(0, -".claim.json".length) : undefined;
			const slot = name === undefined ? undefined : slotFromName(name);
			if (name === undefined || slot === undefined) continue;
			const decision = await readJson<SlotDecisionRecord>(join(dir, file));
			if (!decision || typeof decision.note !== "string" || typeof decision.vault !== "string") continue;
			if (vault !== undefined && decision.vault !== vault) continue;
			if (options.notePath !== undefined && decision.note !== options.notePath) continue;
			entries.push(await entryOf(dir, name, slot, decision, options));
		}
	}
	return entries.sort((a, b) => a.slot.getTime() - b.slot.getTime() || a.note.localeCompare(b.note));
}

/** One slot's entry, from its decision and what followed it. */
async function entryOf(
	dir: string,
	name: string,
	slot: Date,
	decision: SlotDecisionRecord,
	options: Pick<LockOptions, "isAlive" | "host" | "bootTime">
): Promise<SlotEntry> {
	const base = { note: decision.note, vault: decision.vault, schedule: String(decision.schedule), slot, claimedBy: decision };
	if (!isKnownDecision(decision)) {
		return {
			...base,
			state: "unknown",
			kind: "unknown",
			reason: `decided by another version of VaultOre (record version ${String(decision.version)}, kind ${String((decision as { kind?: unknown }).kind)})`,
		};
	}
	const outcome = await readJson<SlotOutcomeRecord>(join(dir, `${name}.outcome.json`));
	const ran = {
		...(outcome?.reason !== undefined ? { reason: outcome.reason } : {}),
		...(outcome?.runId !== undefined ? { runId: outcome.runId } : {}),
		...(outcome?.finishedAt !== undefined ? { finishedAt: outcome.finishedAt } : {}),
	};
	if (decision.kind === "claimed") {
		const gone = outcome ? undefined : runnerGoneBecause(decision, options);
		return {
			...base,
			kind: "claimed",
			state: outcome ? outcome.result : gone ? "abandoned" : "running",
			...ran,
			...(gone !== undefined ? { reason: `the runner ${gone}` } : {}),
		};
	}
	const gap = { ...base, kind: "missed" as const, until: new Date(decision.until), count: decision.count };
	const resolution = await readJson<SlotResolutionRecord>(join(dir, `${name}.resolved.json`));
	if (!resolution) return { ...gap, state: "missed" };
	if (resolution.kind === "dismissed") return { ...gap, state: "dismissed", resolvedBy: resolution };
	const gone = outcome ? undefined : runnerGoneBecause(resolution, options);
	return {
		...gap,
		resolvedBy: resolution,
		state: outcome ? outcome.result : gone ? "abandoned" : "running",
		...ran,
		...(gone !== undefined ? { reason: `the catch-up's runner ${gone}` } : {}),
	};
}

/** A decision this version of the record wrote and knows. */
function isKnownDecision(decision: SlotDecisionRecord): boolean {
	const kind = (decision as { kind?: unknown }).kind;
	return decision.version === RECORD_VERSION && (kind === "claimed" || kind === "missed");
}

/** Why the runner of a claim or a catch-up is gone; undefined while its run may go on. */
function runnerGoneBecause(
	holder: LockHolder & { token: string },
	options: Pick<LockOptions, "isAlive" | "host" | "bootTime">
): string | undefined {
	if (holder.pid === process.pid && openClaims().has(holder.token)) return undefined;
	return holderGoneBecause(holder, options);
}

async function listDirectory(path: string): Promise<string[]> {
	try {
		return await fs.readdir(path);
	} catch (err) {
		if (codeOf(err) === "ENOENT") return [];
		throw err;
	}
}

/** The note directories of the record; anything else there (a `.DS_Store`) is not read. */
async function listNoteDirectories(directory: string): Promise<string[]> {
	try {
		const entries = await fs.readdir(directory, { withFileTypes: true });
		return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
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
	for (const noteDir of await listNoteDirectories(directory)) {
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
				const resolvedPath = join(dir, `${name}.resolved.json`);
				const hasOutcome = (await readJson<SlotOutcomeRecord>(outcomePath)) !== undefined;
				if (!hasOutcome && (await runGoesOn(path, resolvedPath, options))) continue;
				await fs.rm(outcomePath, { force: true });
				await fs.rm(resolvedPath, { force: true });
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

/**
 * Whether a slot with no outcome has a run that may go on: a claim, or a
 * gap's catch-up, whose runner lives. A decision this version does not know,
 * and a gap not caught up, are pruned by age alone.
 */
async function runGoesOn(
	decisionPath: string,
	resolvedPath: string,
	options: Pick<LockOptions, "isAlive" | "host" | "bootTime">
): Promise<boolean> {
	const decision = await readJson<SlotDecisionRecord>(decisionPath);
	if (!decision || !isKnownDecision(decision)) return false;
	if (decision.kind === "claimed") return runnerGoneBecause(decision, options) === undefined;
	const resolution = await readJson<SlotResolutionRecord>(resolvedPath);
	return resolution?.kind === "caught-up" && runnerGoneBecause(resolution, options) === undefined;
}

/** "completed", "skipped: …", for a line of the log. */
export function describeSlotState(entry: SlotEntry): string {
	return entry.reason ? `${entry.state}: ${entry.reason}` : entry.state;
}


// =============================================================================
// MISSED SLOTS (#269)
// =============================================================================

/** Whether a tick that fires `slot` at `now` is too late to run it. */
export function isLateSlot(slot: Date, now: Date = new Date(), lateAfterMs: number = LATE_AFTER_MS): boolean {
	return now.getTime() - slot.getTime() > lateAfterMs;
}

/** The occurrences of `schedule` after `after` up to and including `until`, at most `limit`. */
export function occurrencesBetween(schedule: string, after: Date, until: Date, limit = MAX_GAP_SLOTS): Date[] {
	const found: Date[] = [];
	const interval = CronExpressionParser.parse(schedule, { currentDate: after });
	while (found.length < limit) {
		const next = interval.next().toDate();
		if (next.getTime() > until.getTime()) break;
		found.push(next);
	}
	return found;
}

/** A gap a runner recorded. */
export interface RecordedGap {
	slot: Date;
	until: Date;
	count: number;
}

export interface RecordMissedOptions extends Pick<LockOptions, "host"> {
	vaultRoot: string;
	/** Vault-relative. The note must exist. */
	notePath: string;
	schedule: string;
	/** Which runner looks: "Obsidian", "vaultore agent". */
	by: string;
	/** Days of history to keep, 0 to 30; gaps are not looked for further back. Default 30. */
	keepDays?: number;
	/**
	 * When this runner armed the note with this schedule. For a note whose
	 * record has no slot of this schedule yet, gaps are looked for after it
	 * (less two minutes, which the scheduler still fires); without it, such a
	 * note has none, since nothing is backfilled.
	 */
	armedAt?: Date;
	/** The runner's late threshold (`lateAfterMs`); a gap covers only slots older. Default LATE_AFTER_MS. */
	lateAfterMs?: number;
	directory?: string;
	now?: Date;
}

/**
 * Looks for slots of a note that no runner fired, after its last decided slot,
 * and records each run of them as a gap. Resolves to the gaps this call
 * recorded (another runner may record one first; then it is not reported
 * here). A note with no decided slot yet has none: nothing is backfilled.
 */
export async function recordMissedSlots(options: RecordMissedOptions): Promise<RecordedGap[]> {
	const directory = options.directory ?? slotRecordDirectory();
	const noteDir = join(directory, await noteKey(options.vaultRoot, options.notePath));
	const now = options.now ?? new Date();
	// Strictly older than the margin: a slot exactly that old is still a tick's.
	const margin = options.lateAfterMs ?? GAP_MARGIN_MS;
	const until = new Date(now.getTime() - margin - 1);
	const earliest = new Date(now.getTime() - keepMilliseconds(options.keepDays));
	const recorded: RecordedGap[] = [];

	// Each pass records one gap or finds the slots decided; a lost race or a
	// gap capped at MAX_GAP_SLOTS needs another. Bounded, so a record that
	// keeps changing cannot hold a runner here.
	for (let attempt = 0; attempt < 5; attempt += 1) {
		const last = await lastDecidedSlot(noteDir);
		// A record of another schedule says nothing about this one: after a
		// change from daily to every minute, the minutes before it were never
		// scheduled.
		const since =
			last !== undefined && last.schedule === options.schedule
				? last.slot
				: options.armedAt !== undefined
					? new Date(options.armedAt.getTime() - margin)
					: undefined;
		if (since === undefined) return recorded;
		const after = since.getTime() > earliest.getTime() ? since : earliest;
		const slots = occurrencesBetween(options.schedule, after, until);
		const first = slots[0];
		const lastMissed = slots.at(-1);
		if (first === undefined || lastMissed === undefined) return recorded;

		// A note with no record yet has no directory either.
		await fs.mkdir(noteDir, { recursive: true, mode: 0o700 });
		const token = `${process.pid}.${randomBytes(6).toString("hex")}`;
		const record: SlotMissedRecord = {
			version: RECORD_VERSION,
			kind: "missed",
			vault: await fs.realpath(options.vaultRoot),
			note: options.notePath,
			schedule: options.schedule,
			slot: first.toISOString(),
			until: lastMissed.toISOString(),
			count: slots.length,
			pid: process.pid,
			host: options.host ?? hostname(),
			since: new Date().toISOString(),
			by: options.by,
			token,
		};
		try {
			await writeExclusive(join(noteDir, `${slotName(first)}.claim.json`), JSON.stringify(record) + "\n");
			recorded.push({ slot: first, until: lastMissed, count: slots.length });
		} catch (err) {
			// Another runner decided this slot first, as a claim or a gap: look again after it.
			if (codeOf(err) !== "EEXIST") throw err;
		}
	}
	return recorded;
}

/** The note's last decided slot, and its schedule: the latest claim's slot, or the latest gap's last slot. */
async function lastDecidedSlot(noteDir: string): Promise<{ slot: Date; schedule: string } | undefined> {
	let latest: { name: string; slot: Date } | undefined;
	for (const file of await listDirectory(noteDir)) {
		if (!file.endsWith(".claim.json")) continue;
		const name = file.slice(0, -".claim.json".length);
		const slot = slotFromName(name);
		if (slot !== undefined && (latest === undefined || slot.getTime() > latest.slot.getTime())) latest = { name, slot };
	}
	if (latest === undefined) return undefined;
	const decision = await readJson<SlotDecisionRecord>(join(noteDir, `${latest.name}.claim.json`));
	const schedule = typeof decision?.schedule === "string" ? decision.schedule : "";
	if (decision?.kind === "missed") {
		const until = new Date(decision.until);
		if (!Number.isNaN(until.getTime()) && until.getTime() > latest.slot.getTime()) return { slot: until, schedule };
	}
	return { slot: latest.slot, schedule };
}

/** A gap cannot be resolved as asked; the message says why and what to do. */
export class MissedSlotError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "MissedSlotError";
	}
}

export interface ResolveMissedOptions extends Pick<LockOptions, "host" | "isAlive" | "bootTime"> {
	vaultRoot: string;
	notePath: string;
	/** The gap's first slot; without one, the note's open gap (all of them, to dismiss). */
	slot?: Date;
	/** Who resolves it: "Obsidian", "vaultore". */
	by: string;
	directory?: string;
}

/**
 * Dismisses the note's open gap, or the one at `slot`; without a slot, all
 * its open gaps. Resolves to the gaps dismissed. Rejects with
 * MissedSlotError when there is none, or the one named is not open.
 */
export async function dismissMissedSlots(options: ResolveMissedOptions): Promise<SlotEntry[]> {
	const gaps = await openGapsFor(options, "dismiss");
	const directory = options.directory ?? slotRecordDirectory();
	const noteDir = join(directory, await noteKey(options.vaultRoot, options.notePath));
	const dismissed: SlotEntry[] = [];
	for (const gap of gaps) {
		const done = await writeResolution(noteDir, gap, "dismissed", options);
		if (done) dismissed.push(gap);
	}
	if (dismissed.length === 0) {
		throw new MissedSlotError(`The missed runs of ${options.notePath} were resolved by another runner meanwhile`);
	}
	return dismissed;
}

/**
 * Takes the note's open gap, or the one at `slot`, for a catch-up: the
 * resolution is written, and the claim returned is what the run finishes, as
 * a scheduled run finishes its claim. Rejects with MissedSlotError when there
 * is no open gap, several and none named, or the one named is not open.
 */
export async function catchUpMissedSlot(options: ResolveMissedOptions): Promise<SlotClaim & { gap: SlotEntry }> {
	const gaps = await openGapsFor(options, "catch-up");
	const [gap] = gaps;
	if (gap === undefined || gaps.length > 1) {
		throw new MissedSlotError(
			`${options.notePath} has ${gaps.length} missed runs; name the one to catch up by its first slot: ` +
				gaps.map((g) => g.slot.toISOString()).join(", ")
		);
	}
	const directory = options.directory ?? slotRecordDirectory();
	const noteDir = join(directory, await noteKey(options.vaultRoot, options.notePath));
	const token = await writeResolution(noteDir, gap, "caught-up", options);
	if (token === undefined) {
		throw new MissedSlotError(
			`The missed runs of ${options.notePath} from ${gap.slot.toISOString()} were resolved by another runner meanwhile`
		);
	}
	return { ...outcomeWriter(noteDir, slotName(gap.slot), gap.slot, token), gap };
}

/** The note's open gaps, or the one at `options.slot`; refuses when there is none to act on. */
async function openGapsFor(options: ResolveMissedOptions, action: "dismiss" | "catch-up"): Promise<SlotEntry[]> {
	const entries = await readSlotRecord({
		vaultRoot: options.vaultRoot,
		notePath: options.notePath,
		...(options.directory !== undefined ? { directory: options.directory } : {}),
		...(options.isAlive !== undefined ? { isAlive: options.isAlive } : {}),
		...(options.host !== undefined ? { host: options.host } : {}),
		...(options.bootTime !== undefined ? { bootTime: options.bootTime } : {}),
	});
	const gaps = entries.filter((entry) => entry.kind === "missed");
	if (options.slot !== undefined) {
		const at = options.slot.getTime();
		const gap = gaps.find((entry) => entry.slot.getTime() === at);
		if (!gap) {
			throw new MissedSlotError(`${options.notePath} has no missed runs from ${options.slot.toISOString()}`);
		}
		if (gap.state !== "missed") {
			const by = gap.resolvedBy ? ` by ${describeHolder(gap.resolvedBy)}` : "";
			const what = gap.state === "dismissed" ? "dismissed" : "caught up";
			throw new MissedSlotError(
				`The missed runs of ${options.notePath} from ${gap.slot.toISOString()} were ${what} already${by}, so they cannot be ${action === "dismiss" ? "dismissed" : "caught up"}`
			);
		}
		return [gap];
	}
	const open = gaps.filter((entry) => entry.state === "missed");
	if (open.length === 0) throw new MissedSlotError(`${options.notePath} has no missed runs to ${action}`);
	return open;
}

/** Writes a gap's resolution exclusively; resolves to its token, or undefined when one was there. */
async function writeResolution(
	noteDir: string,
	gap: SlotEntry,
	kind: SlotResolutionRecord["kind"],
	options: Pick<ResolveMissedOptions, "by" | "host">
): Promise<string | undefined> {
	const token = `${process.pid}.${randomBytes(6).toString("hex")}`;
	const record: SlotResolutionRecord = {
		version: RECORD_VERSION,
		kind,
		pid: process.pid,
		host: options.host ?? hostname(),
		since: new Date().toISOString(),
		by: options.by,
		token,
	};
	const open = openClaims();
	if (kind === "caught-up") open.add(token);
	try {
		await writeExclusive(join(noteDir, `${slotName(gap.slot)}.resolved.json`), JSON.stringify(record) + "\n");
		return token;
	} catch (err) {
		open.delete(token);
		if (codeOf(err) === "EEXIST") return undefined;
		throw err;
	}
}
