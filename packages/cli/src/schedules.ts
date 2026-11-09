/**
 * @vaultore/cli - `vaultore schedules list | approve | revoke`
 *
 * The commands that say which scheduled notes `vaultore agent` may run. Kept
 * out of cli.ts so they can be unit tested — cli.ts runs main() on import.
 */

import {
	WorkflowParser,
	classifyScheduleApproval,
	computeNextRun,
	errorMessage,
	grantHash,
} from "@vaultore/core";
import type { ScheduleApprovalState, Workflow } from "@vaultore/core";
import type { ApprovalStore, VaultApprovals } from "./approvals";
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
	/** `no-note`: an approval whose path holds no scheduled workflow any more. */
	state: ScheduleApprovalState | "no-note";
	/** When the approval was given, where there is one. */
	approvedAt?: string;
}

/**
 * Every scheduled note with its state, in the order given, then the approvals
 * that no scheduled note answers to (deleted, renamed, or no longer scheduled).
 */
export function listSchedules(notes: ScheduledNote[], approvals: VaultApprovals): ScheduleListEntry[] {
	const entries: ScheduleListEntry[] = notes.map((note) => {
		const state = classifyScheduleApproval(approvals, note.path, note.hash);
		const approvedAt = state === "not-approved" ? undefined : approvals[note.path]?.approvedAt;
		return {
			path: note.path,
			schedule: note.schedule,
			state,
			...(approvedAt === undefined ? {} : { approvedAt }),
		};
	});

	const present = new Set(notes.map((note) => note.path));
	for (const [path, approval] of Object.entries(approvals)) {
		if (present.has(path)) continue;
		entries.push({
			path,
			schedule: approval.schedule,
			state: "no-note",
			approvedAt: approval.approvedAt,
		});
	}
	return entries;
}

const STATE_LABELS: Record<ScheduleListEntry["state"], string> = {
	approved: "approved",
	"not-approved": "not approved",
	changed: "changed since approval",
	"no-note": "no scheduled note",
};

/** One line per entry, the state first. */
export function formatScheduleList(entries: ScheduleListEntry[]): string[] {
	if (entries.length === 0) return ["No scheduled workflow notes found."];
	return entries.map((entry) => {
		const approved =
			entry.state === "changed" || entry.state === "no-note"
				? ` (approved ${entry.approvedAt ?? "?"})`
				: "";
		return `${STATE_LABELS[entry.state].padEnd(24)}${entry.path} [${entry.schedule}]${approved}`;
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

/**
 * Approve the notes as they are now. All of them or none: one refused note
 * (unreadable, no workflow, no schedule) leaves the approvals untouched.
 * Approving a note that is already approved as it is changes nothing.
 */
export async function approveSchedules(options: {
	/** Vault-relative note paths. */
	paths: string[];
	readNote: (path: string) => Promise<string>;
	store: ApprovalStore;
	vaultKey: string;
	now?: () => string;
}): Promise<ScheduleCommandResult> {
	const now = options.now ?? (() => new Date().toISOString());

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
	const written = await options.store.update(options.vaultKey, (approvals) => {
		for (const note of notes) {
			const state = classifyScheduleApproval(approvals, note.path, note.hash);
			if (state === "approved") {
				lines.push(`already approved ${note.path} [${note.schedule}]`);
				continue;
			}
			const replaced =
				state === "changed"
					? ` (replaces the approval of ${approvals[note.path]?.approvedAt ?? "?"})`
					: "";
			approvals[note.path] = { hash: note.hash, schedule: note.schedule, approvedAt: now() };
			lines.push(`approved ${note.path} [${note.schedule}]${replaced}`);
		}
	});
	if (written) lines.push(`stored in ${options.store.file}`);
	return { ok: true, lines };
}

/**
 * Withdraw the approvals of the given paths. A path that has none is reported
 * and is no error: the state asked for is the state there is.
 */
export async function revokeSchedules(options: {
	/** Vault-relative note paths. The notes need not exist any more. */
	paths: string[];
	store: ApprovalStore;
	vaultKey: string;
}): Promise<ScheduleCommandResult> {
	const lines: string[] = [];
	const written = await options.store.update(options.vaultKey, (approvals) => {
		for (const path of options.paths) {
			if (!Object.prototype.hasOwnProperty.call(approvals, path)) {
				lines.push(`not approved: ${path}`);
				continue;
			}
			delete approvals[path];
			lines.push(`revoked ${path}`);
		}
	});
	if (written) lines.push(`stored in ${options.store.file}`);
	return { ok: true, lines };
}
