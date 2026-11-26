/**
 * @vaultore/cli - agent helpers
 *
 * Kept out of cli.ts so they can be unit tested — cli.ts runs main() on
 * import.
 */

import { errorMessage, noteScheduleState, ownerName } from "@vaultore/core";
import type { NoteScheduleState, VaultSchedules } from "@vaultore/core";
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

/** Why the agent does not run a note; undefined when it does. */
function skipReason(state: NoteScheduleState): string | undefined {
	switch (state.state) {
		case "approved":
			return undefined;
		case "not-approved":
			return "it is not approved";
		case "changed":
			return "it changed since it was approved";
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
		else skipped.push({ path: note.path, reason: skipReason(state) ?? "" });
	}
	return { register, skipped, delegated };
}

/**
 * Wrap `run` so a due note runs only if it is approved as it is at that
 * moment. The rescan that armed it may be minutes old: the note is read again,
 * and so are the approvals, so an edit, a deletion or a revoke since then is
 * honoured. `run` gets the content that was checked, so what runs is what was
 * approved. A note that may not run is passed to `onRefuse`.
 */
export function createApprovedRunner<A = void>(options: {
	readNote: (path: string) => Promise<{ note: ScheduledNote; content: string }>;
	schedules: () => Promise<VaultSchedules>;
	run: (path: string, content: string, arg: A) => Promise<void>;
	onRefuse: (path: string, reason: string) => void;
}): (path: string, arg: A) => Promise<void> {
	return async (path, arg) => {
		let content: string;
		try {
			const read = await options.readNote(path);
			const reason = skipReason(noteScheduleState("agent", await options.schedules(), read.note));
			if (reason !== undefined) {
				options.onRefuse(path, reason);
				return;
			}
			content = read.content;
		} catch (err) {
			options.onRefuse(path, errorMessage(err));
			return;
		}
		await options.run(path, content, arg);
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
