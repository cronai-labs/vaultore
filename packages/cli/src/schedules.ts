/**
 * @vaultore/cli - `vaultore schedules list | approve | revoke`
 *
 * The commands that say which scheduled notes run on this computer, and in
 * which runner: `vaultore agent` or Obsidian (#301). Kept
 * out of cli.ts so they can be unit tested — cli.ts runs main() on import.
 */

import {
	MAX_LATE_AFTER_MINUTES,
	MIN_LATE_AFTER_MINUTES,
	WorkflowParser,
	approveNote,
	computeNextRun,
	errorMessage,
	grantHash,
	isLateAfterMinutes,
	noteScheduleState,
	own,
	ownerName,
	readMachineSettings,
	revokeNote,
	writeMachineSettings,
} from "@vaultore/core";
import type { ScheduleOwner, SlotEntry, VaultSchedules, VaultStateStore, Workflow } from "@vaultore/core";
import type { DiscoveredWorkflow } from "./scan";

const parser = new WorkflowParser();

/** A workflow note with a schedule, and the hash an approval of it is bound to. */
export interface ScheduledNote {
	/** Vault-relative path. */
	path: string;
	schedule: string;
	/** `grantHash`: the front matter and each cell's attributes and source. */
	hash: string;
}

async function scheduledNoteOf(path: string, workflow: Workflow): Promise<ScheduledNote | undefined> {
	const schedule = workflow.frontmatter.schedule;
	if (!schedule) return undefined;
	return { path, schedule: String(schedule), hash: await grantHash(workflow, parser) };
}

/** The scheduled notes among the discovered workflows, in the order found. */
export async function scheduledNotes(discovered: DiscoveredWorkflow[]): Promise<ScheduledNote[]> {
	const notes: ScheduledNote[] = [];
	for (const item of discovered) {
		const note = await scheduledNoteOf(item.path, item.workflow);
		if (note) notes.push(note);
	}
	return notes;
}

/**
 * Read one note as a scheduled workflow, or say why it is none. The reason
 * completes "<path>: …" and "not approving <path>: …".
 */
export async function readScheduledNote(
	readNote: (path: string) => Promise<string>,
	path: string
): Promise<{ note: ScheduledNote; content: string }> {
	let content: string;
	try {
		content = await readNote(path);
	} catch (err) {
		throw new Error(`it cannot be read (${errorMessage(err)})`);
	}
	if (!parser.isWorkflow(content)) {
		const yamlError = parser.workflowFrontmatterError(content);
		throw new Error(yamlError ?? "it is not a workflow note");
	}

	const note = await scheduledNoteOf(path, parser.parse(content, path));
	if (!note) throw new Error("it has no schedule");
	try {
		computeNextRun(note.schedule);
	} catch {
		throw new Error(`its schedule '${note.schedule}' is not a cron expression`);
	}
	return { note, content };
}

// =============================================================================
// LIST
// =============================================================================

export interface ScheduleListEntry {
	path: string;
	schedule: string;
	/** Who runs it on this computer, where it is approved. */
	owner?: ScheduleOwner;
	/**
	 * Whether its owner runs it now (`noteScheduleState` from the owner's side);
	 * `no-note`: an approval whose path holds no scheduled workflow any more.
	 */
	state: "approved" | "not-approved" | "changed" | "off" | "no-note";
	/** When the approval was given, where there is one. */
	approvedAt?: string;
}

/**
 * Every scheduled note with its owner and state, in the order given, then the
 * approvals that no scheduled note answers to (deleted, renamed, or no longer
 * scheduled).
 */
export function listSchedules(notes: ScheduledNote[], schedules: VaultSchedules): ScheduleListEntry[] {
	const entries: ScheduleListEntry[] = notes.map((note) => {
		const approval = own(schedules.notes, note.path);
		if (approval === undefined) return { path: note.path, schedule: note.schedule, state: "not-approved" };
		const { state } = noteScheduleState(approval.owner, schedules, note);
		return {
			path: note.path,
			schedule: note.schedule,
			owner: approval.owner,
			state: state === "delegated" ? "approved" : state,
			approvedAt: approval.approvedAt,
		};
	});

	const present = new Set(notes.map((note) => note.path));
	for (const [path, approval] of Object.entries(schedules.notes)) {
		if (present.has(path)) continue;
		entries.push({ path, schedule: approval.schedule, owner: approval.owner, state: "no-note", approvedAt: approval.approvedAt });
	}
	return entries;
}

const STATE_LABELS: Record<ScheduleListEntry["state"], string> = {
	approved: "runs",
	"not-approved": "not approved",
	changed: "changed since approval",
	off: "Obsidian's scheduling off",
	"no-note": "no scheduled note",
};

/** One line per entry: the state, then who runs it, then the note. */
export function formatScheduleList(entries: ScheduleListEntry[]): string[] {
	if (entries.length === 0) return ["No scheduled workflow notes found."];
	return entries.map((entry) => {
		const approved =
			entry.state === "changed" || entry.state === "no-note" ? ` (approved ${entry.approvedAt ?? "?"})` : "";
		const owner = entry.owner === undefined ? "" : ownerName(entry.owner);
		return `${STATE_LABELS[entry.state].padEnd(27)}${owner.padEnd(16)}${entry.path} [${entry.schedule}]${approved}`;
	});
}

// =============================================================================
// APPROVE / REVOKE
// =============================================================================

export interface ScheduleCommandResult {
	/** False when the command refused; the lines then say why. */
	ok: boolean;
	lines: string[];
}

/** `--owner`: who runs the notes approved; the agent unless given. */
export function ownerFrom(flag: string | boolean | undefined): ScheduleOwner {
	if (flag === undefined) return "agent";
	if (flag === "agent" || flag === "obsidian") return flag;
	throw new Error(`--owner takes agent or obsidian, got '${String(flag)}'`);
}

/**
 * Approve the notes as they are now, to run in `owner`. All of them or none:
 * one refused note (unreadable, no workflow, no schedule) leaves the approvals
 * untouched. Approving a note already approved as it is, for the same owner,
 * changes nothing; approving it for the other owner hands it over.
 */
export async function approveSchedules(options: {
	/** Vault-relative note paths. */
	paths: string[];
	readNote: (path: string) => Promise<string>;
	store: VaultStateStore<VaultSchedules>;
	vaultKey: string;
	owner?: ScheduleOwner;
	now?: () => Date;
}): Promise<ScheduleCommandResult> {
	const now = options.now ?? (() => new Date());
	const owner = options.owner ?? "agent";

	const notes: ScheduledNote[] = [];
	const refusals: string[] = [];
	for (const path of options.paths) {
		try {
			notes.push((await readScheduledNote(options.readNote, path)).note);
		} catch (err) {
			refusals.push(`not approving ${path}: ${errorMessage(err)}`);
		}
	}
	if (refusals.length > 0) {
		return { ok: false, lines: [...refusals, "nothing was approved"] };
	}

	const lines: string[] = [];
	const written = await options.store.update(options.vaultKey, (schedules) => {
		for (const note of notes) {
			const before = own(schedules.notes, note.path);
			if (before?.owner === owner && before.hash === note.hash && before.schedule === note.schedule) {
				lines.push(`already approved ${note.path} [${note.schedule}] for ${ownerName(owner)}`);
				continue;
			}
			const replaced =
				before === undefined
					? ""
					: before.owner !== owner
						? ` (handed over from ${ownerName(before.owner)})`
						: ` (replaces the approval of ${before.approvedAt})`;
			approveNote(schedules, note, owner, now());
			lines.push(`approved ${note.path} [${note.schedule}] for ${ownerName(owner)}${replaced}`);
			if (owner === "obsidian" && !schedules.obsidianScheduling) {
				lines.push(`  Obsidian runs it once "Run scheduled workflows" is on in VaultOre's settings`);
			}
		}
	});
	if (written) lines.push(`stored in ${options.store.file}`);
	return { ok: true, lines };
}

/**
 * Withdraw the approvals of the given paths, whoever owns them. A path that
 * has none is reported and is no error: the state asked for is the state there
 * is.
 */
export async function revokeSchedules(options: {
	/** Vault-relative note paths. The notes need not exist any more. */
	paths: string[];
	store: VaultStateStore<VaultSchedules>;
	vaultKey: string;
}): Promise<ScheduleCommandResult> {
	const lines: string[] = [];
	const written = await options.store.update(options.vaultKey, (schedules) => {
		for (const path of options.paths) {
			const owner = own(schedules.notes, path)?.owner;
			if (!revokeNote(schedules, path)) {
				lines.push(`not approved: ${path}`);
				continue;
			}
			lines.push(`revoked ${path} (was run by ${ownerName(owner ?? "agent")})`);
		}
	});
	if (written) lines.push(`stored in ${options.store.file}`);
	return { ok: true, lines };
}

// =============================================================================
// LOG (#255)
// =============================================================================

/**
 * The lines of `vaultore schedules log`: one per slot, oldest first, with what
 * it came to, the runner that claimed it, and why when it did not complete.
 */
export function formatSlotLog(entries: SlotEntry[]): string[] {
	if (entries.length === 0) return ["No scheduled run recorded."];
	return entries.map((entry) => {
		const by = entry.claimedBy.by ?? `process ${entry.claimedBy.pid}`;
		const run = entry.runId ? ` run ${entry.runId}` : "";
		const reason = entry.reason ? `: ${entry.reason}` : "";
		const head = `${entry.slot.toISOString()}  ${entry.state.padEnd(9)}  ${entry.note} [${entry.schedule}]`;
		if (entry.kind !== "missed") return `${head} by ${by}${run}${reason}`;
		// A gap: how many runs it holds, who found it, and who resolved it.
		const runs = `${entry.count ?? 1} missed run(s) to ${(entry.until ?? entry.slot).toISOString()}, found by ${by}`;
		const resolved = entry.resolvedBy
			? `; ${entry.resolvedBy.kind === "dismissed" ? "dismissed" : "caught up"} by ${entry.resolvedBy.by ?? `process ${entry.resolvedBy.pid}`}`
			: "";
		return `${head} ${runs}${resolved}${run}${reason}`;
	});
}

/**
 * `vaultore schedules late-after [<minutes> | default]`: shows, or sets for
 * this machine, how many minutes late a scheduled run may start, in the file
 * both runners read. Returns the line to print; a value out of range throws.
 */
export async function lateAfter(value: string | undefined, path: string): Promise<string> {
	let minutes: number | undefined;
	if (value !== undefined && value !== "default") {
		minutes = /^\d+$/.test(value) ? Number(value) : Number.NaN;
		if (!isLateAfterMinutes(minutes)) {
			throw new Error(
				`late after must be a whole number of minutes from ${MIN_LATE_AFTER_MINUTES} to ${MAX_LATE_AFTER_MINUTES}, or default, got '${value}'`
			);
		}
	}
	const settings =
		value === undefined ? await readMachineSettings({ path }) : await writeMachineSettings({ lateAfterMinutes: minutes }, { path });
	const source = settings.lateAfterMinutes === undefined ? "the default" : `set in ${path}`;
	return `late after ${settings.lateAfterMinutes ?? MIN_LATE_AFTER_MINUTES} minutes (${source})`;
}
