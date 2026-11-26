/**
 * @vaultore/cli - `vaultore schedules list | approve | revoke`
 *
 * The commands that say which scheduled notes run on this computer, and in
 * which runner: `vaultore agent` or Obsidian (#301). Kept
 * out of cli.ts so they can be unit tested — cli.ts runs main() on import.
 */

import {
	APPROVAL_PERMISSION_KEYS,
	MAX_LATE_AFTER_MINUTES,
	MIN_LATE_AFTER_MINUTES,
	WorkflowParser,
	approveNote,
	approvedPermissions,
	computeNextRun,
	errorMessage,
	isLateAfterMinutes,
	noteScheduleState,
	own,
	ownerName,
	readMachineSettings,
	reviewApproval,
	revokeNote,
	scheduledNoteOf as coreScheduledNoteOf,
	writeMachineSettings,
} from "@vaultore/core";
import { SHORT_WAIT } from "./wait";
import type {
	ApprovalPermissionKey,
	ApprovalReview,
	ScheduleOwner,
	ScheduledNoteNow,
	SlotEntry,
	VaultSchedules,
	VaultStateStore,
	Workflow,
} from "@vaultore/core";
import type { DiscoveredWorkflow } from "./scan";

const parser = new WorkflowParser();

/** A workflow note with a schedule, as an approval sees it: its hash and its permissions. */
export type ScheduledNote = ScheduledNoteNow;

async function scheduledNoteOf(path: string, workflow: Workflow): Promise<ScheduledNote | undefined> {
	const note = await coreScheduledNoteOf(workflow, parser);
	return note === undefined ? undefined : { ...note, path };
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

/** Answers for permissions at `ask`, from `--allow` and `--deny`: comma-separated names (#299). */
export type ApprovalAnswers = Partial<Record<ApprovalPermissionKey, "allow" | "deny">>;

/** `--allow a,b --deny c` as answers; refuses a name it does not know, or one given both ways. */
export function answersFrom(allow: string | boolean | undefined, deny: string | boolean | undefined): ApprovalAnswers {
	const answers: ApprovalAnswers = {};
	for (const [flag, value, answer] of [
		["allow", allow, "allow"],
		["deny", deny, "deny"],
	] as const) {
		if (value === undefined) continue;
		if (typeof value !== "string" || value === "") throw new Error(`--${flag} takes permission names, as in --${flag} network,vaultWrite`);
		for (const name of value.split(",").map((part) => part.trim())) {
			if (!(APPROVAL_PERMISSION_KEYS as readonly string[]).includes(name)) {
				throw new Error(`--${flag}: ${name} is no permission; they are ${APPROVAL_PERMISSION_KEYS.join(", ")}`);
			}
			const key = name as ApprovalPermissionKey;
			if (answers[key] !== undefined && answers[key] !== answer) throw new Error(`${key} is given to both --allow and --deny`);
			answers[key] = answer;
		}
	}
	return answers;
}

const STATUS_LABELS: Record<ApprovalReview["permissions"][number]["status"], string> = {
	kept: "kept",
	new: "new",
	changed: "changed",
	"needs-answer": "asks",
	"answer-dropped": "dropped",
};

/** What an approval holds, one line per permission, and what changed against the one before. */
export function formatReview(review: ApprovalReview, answers: ApprovalAnswers): string[] {
	return review.permissions.map((p) => {
		const answer = answers[p.key];
		const value = answer ?? p.result?.value ?? "?";
		const source =
			answer !== undefined || p.result?.source === "answer" ? "answer" : p.status === "needs-answer" ? "needs an answer" : "frontmatter";
		const before = p.status === "changed" && p.before ? `${p.before.value} -> ` : "";
		const label = answer !== undefined && p.status === "kept" ? "answered" : STATUS_LABELS[p.status];
		const dropped = p.status === "answer-dropped" && p.before ? ` (the answer ${p.before.value} no longer applies)` : "";
		return `  ${label.padEnd(9)}${p.key.padEnd(13)}${before}${value} (${source})${dropped}`;
	});
}

/** A refusal inside the store's update: nothing is written. */
class Refused extends Error {
	constructor(readonly lines: string[]) {
		super(lines.join("; "));
	}
}

/**
 * Approve the notes as they are now, to run in `owner`, with the permissions
 * unattended runs get (#299): those the frontmatter sets, and `answers` for
 * those at `ask`. Approving again asks only about what changed: an answer
 * given before is kept. All of them or none: one refused note (unreadable, no
 * workflow, no schedule, an `ask` without an answer) leaves the approvals
 * untouched. Approving a note already approved as it is, for the same owner,
 * changes nothing; approving it for the other owner hands it over, with the
 * same review.
 */
export async function approveSchedules(options: {
	/** Vault-relative note paths. */
	paths: string[];
	readNote: (path: string) => Promise<string>;
	store: VaultStateStore<VaultSchedules>;
	vaultKey: string;
	owner?: ScheduleOwner;
	answers?: ApprovalAnswers;
	now?: () => Date;
}): Promise<ScheduleCommandResult> {
	const now = options.now ?? (() => new Date());
	const owner = options.owner ?? "agent";
	const answers = options.answers ?? {};
	if (Object.keys(answers).length > 0 && options.paths.length > 1) {
		return { ok: false, lines: ["--allow and --deny answer for one note at a time; nothing was approved"] };
	}

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
	let written: boolean;
	try {
		// Reviewed inside the update: against the approvals as they are when
		// written, not as they were read before.
		written = await options.store.update(options.vaultKey, (schedules) => {
			const refused: string[] = [];
			for (const note of notes) {
				const before = own(schedules.notes, note.path);
				const review = reviewApproval(before, note);
				if (
					before?.owner === owner &&
					before.hash === note.hash &&
					before.schedule === note.schedule &&
					!review.changed &&
					Object.keys(answers).length === 0
				) {
					lines.push(`already approved ${note.path} [${note.schedule}] for ${ownerName(owner)}`);
					continue;
				}
				let permissions;
				try {
					permissions = approvedPermissions(review, answers);
				} catch (err) {
					const keys = review.needsAnswer.join(",");
					const hint = review.needsAnswer.length > 0 ? `; answer with --allow ${keys} or --deny ${keys}` : "";
					refused.push(`not approving ${note.path}: ${errorMessage(err)}${hint}`, ...formatReview(review, answers));
					continue;
				}
				const replaced =
					before === undefined
						? ""
						: before.owner !== owner
							? ` (handed over from ${ownerName(before.owner)})`
							: ` (replaces the approval of ${before.approvedAt})`;
				approveNote(schedules, note, owner, permissions, now());
				lines.push(`approved ${note.path} [${note.schedule}] for ${ownerName(owner)}${replaced}`);
				if (review.changed || Object.keys(answers).length > 0) lines.push(...formatReview(review, answers));
				if (owner === "obsidian" && !schedules.obsidianScheduling) {
					lines.push(`  Obsidian runs it once "Run scheduled workflows" is on in VaultOre's settings`);
				}
			}
			if (refused.length > 0) throw new Refused(refused);
		});
	} catch (err) {
		if (err instanceof Refused) return { ok: false, lines: [...err.lines, "nothing was approved"] };
		throw err;
	}
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
		value === undefined ? await readMachineSettings({ path }) : await writeMachineSettings({ lateAfterMinutes: minutes }, { path, wait: SHORT_WAIT });
	const source = settings.lateAfterMinutes === undefined ? "the default" : `set in ${path}`;
	return `late after ${settings.lateAfterMinutes ?? MIN_LATE_AFTER_MINUTES} minutes (${source})`;
}
