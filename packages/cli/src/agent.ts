/**
 * @vaultore/cli - agent helpers
 *
 * Kept out of cli.ts so they can be unit tested — cli.ts runs main() on
 * import.
 */

import { bindingOf, errorMessage, noteScheduleState, ownerName } from "@vaultore/core";
import type { ApprovalReview, NoteApproval, NoteScheduleState, UnattendedApproval, VaultSchedules } from "@vaultore/core";
import type { ScheduledNote } from "./schedules";

/**
 * Wrap `run` so a workflow runs at most once at a time. The scheduler fires on
 * every tick whether or not the previous run of that note finished, and two
 * runs of one note write outputs back into it concurrently (#27). A call for a
 * path that is still running is skipped and reported through `onSkip`.
 */
export function createSingleFlightRunner<A = void>(
	run: (path: string, arg: A) => Promise<void>,
	onSkip: (path: string, arg: A) => unknown
): (path: string, arg: A) => Promise<void> {
	const inFlight = new Set<string>();
	return async (path, arg) => {
		if (inFlight.has(path)) {
			await onSkip(path, arg);
			return;
		}
		inFlight.add(path);
		try {
			await run(path, arg);
		} finally {
			inFlight.delete(path);
		}
	};
}

// =============================================================================
// APPROVALS (#116, #301)
// =============================================================================

/** A scheduled note the agent does not run, and why. The reason completes "not running <path>: …". */
export interface SkippedNote {
	path: string;
	reason: string;
}

/**
 * What changed in a note since it was approved, and the command that
 * approves it again: with an answer for each permission newly at `ask`
 * (#299). Completes "<path>: …".
 */
export function changedReason(path: string, review: ApprovalReview, approval?: NoteApproval): string {
	const changed = review.permissions.filter((p) => p.status === "changed" || p.status === "answer-dropped").map((p) => `${p.key} is now ${p.now}`);
	const what = changed.length > 0 ? `; ${changed.join(", ")}` : "";
	if (review.needsAnswer.length > 0) {
		const keys = review.needsAnswer.join(",");
		// Copied from 0.4.x, whose approvals held no answers: nothing changed (#310).
		if (approval !== undefined && approval.permissions === undefined) {
			return `it was approved by an earlier version, whose approvals held no answers, and ${review.needsAnswer.join(", ")} ` +
				`${review.needsAnswer.length === 1 ? "asks" : "ask"}: approve it with an answer, vaultore schedules approve ${path} --allow ${keys} (or --deny ${keys})`;
		}
		return `it changed since it was approved${what}; ${review.needsAnswer.join(", ")} now ${review.needsAnswer.length === 1 ? "asks" : "ask"}: ` +
			`approve it with an answer, vaultore schedules approve ${path} --allow ${keys} (or --deny ${keys})`;
	}
	return `it changed since it was approved${what}; approve it again: vaultore schedules approve ${path}`;
}

/** Why the agent does not run a note; undefined when it does. */
function skipReason(state: NoteScheduleState, path: string): string | undefined {
	switch (state.state) {
		case "approved":
			return undefined;
		case "not-approved":
			return "it is not approved";
		case "changed":
			return changedReason(path, state.review, state.approval);
		case "delegated":
		case "off":
			return `it is handed to ${ownerName(state.approval.owner)}`;
	}
}

/**
 * Which scheduled notes to arm: those the agent owns, with an approval that
 * matches the note as it is now (#301). Notes it does not own and nobody
 * approved are skipped with the reason; notes handed to Obsidian are left out
 * silently, as they are Obsidian's to run.
 */
export function planRegistrations(
	notes: ScheduledNote[],
	schedules: VaultSchedules
): { register: ScheduledNote[]; skipped: SkippedNote[]; delegated: ScheduledNote[] } {
	const register: ScheduledNote[] = [];
	const skipped: SkippedNote[] = [];
	const delegated: ScheduledNote[] = [];
	for (const note of notes) {
		const state = noteScheduleState("agent", schedules, note);
		if (state.state === "approved") register.push(note);
		else if (state.state === "delegated") delegated.push(note);
		else skipped.push({ path: note.path, reason: skipReason(state, note.path) ?? "" });
	}
	return { register, skipped, delegated };
}

/**
 * Wrap `run` so a due note runs only if it is approved as it is at that
 * moment. The rescan that armed it may be minutes old: the note is read again,
 * and so are the approvals, so an edit, a deletion or a revoke since then is
 * honoured. `run` gets the content that was checked and the approval it was
 * checked against, so what runs is what was approved, with the permissions
 * approved (#299). A note that may not run is passed to `onRefuse`.
 */
export function createApprovedRunner<A = void>(options: {
	readNote: (path: string) => Promise<{ note: ScheduledNote; content: string }>;
	schedules: () => Promise<VaultSchedules>;
	run: (path: string, content: string, arg: A, unattended: UnattendedApproval) => Promise<void>;
	onRefuse: (path: string, reason: string) => void;
}): (path: string, arg: A) => Promise<void> {
	return async (path, arg) => {
		let content: string;
		let unattended: UnattendedApproval;
		try {
			const read = await options.readNote(path);
			const schedules = await options.schedules();
			const state = noteScheduleState("agent", schedules, read.note);
			if (state.state !== "approved") {
				options.onRefuse(path, skipReason(state, path) ?? "");
				return;
			}
			content = read.content;
			unattended = { approval: state.approval, binding: bindingOf(schedules, "agent") };
		} catch (err) {
			options.onRefuse(path, errorMessage(err));
			return;
		}
		await options.run(path, content, arg, unattended);
	};
}

/**
 * Reports what a rescan left unarmed: each skipped note with its reason, and
 * a plain line when nothing will run at all. The agent rescans every few
 * minutes, so the same state is reported once and again only when it changes.
 */
export function createSkipReporter(
	write: (line: string) => void
): (state: { registered: number; skipped: SkippedNote[]; delegated?: number }) => void {
	let last: string | undefined;
	return ({ registered, skipped, delegated = 0 }) => {
		const signature = JSON.stringify([registered === 0, delegated > 0, skipped.map((s) => [s.path, s.reason])]);
		if (signature === last) return;
		last = signature;

		for (const note of skipped) {
			write(`not running ${note.path}: ${note.reason}`);
		}
		if (registered > 0) return;
		write(
			delegated > 0 && skipped.length === 0
				? "every scheduled workflow is handed to Obsidian, so nothing runs here; hand one to the agent with: vaultore schedules approve <note.md>"
				: skipped.length > 0
				? "no scheduled workflow is approved, so nothing will run; approve one with: vaultore schedules approve <note.md>"
				: "no scheduled workflow found, so nothing will run"
		);
	};
}

/**
 * Runs a rescan that may fail without ending the agent (#313): a vault
 * unreadable for a moment (a network share, a disk unmounted) would otherwise
 * be an unhandled rejection. A failed rescan leaves the notes armed as they
 * were and is tried again at the next one; its reason is written once, and
 * again when it changes, and recovery is written once.
 */
export function createGuardedRescan(rescan: () => Promise<void>, write: (line: string) => void): () => Promise<void> {
	let failing: string | undefined;
	return async () => {
		try {
			await rescan();
			if (failing !== undefined) write("rescanning works again");
			failing = undefined;
		} catch (err) {
			const message = errorMessage(err);
			if (message !== failing) write(`could not rescan the vault: ${message}; the notes stay armed as they were, and it is tried again at the next rescan`);
			failing = message;
		}
	};
}
