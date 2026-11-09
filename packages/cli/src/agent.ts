/**
 * @vaultore/cli - agent helpers
 *
 * Kept out of cli.ts so they can be unit tested — cli.ts runs main() on
 * import.
 */

import { classifyScheduleApproval, errorMessage } from "@vaultore/core";
import type { VaultApprovals } from "./approvals";
import type { ScheduledNote } from "./schedules";

/**
 * Wrap `run` so a workflow runs at most once at a time. The scheduler fires on
 * every tick whether or not the previous run of that note finished, and two
 * runs of one note write outputs back into it concurrently (#27). A call for a
 * path that is still running is skipped and reported through `onSkip`.
 */
export function createSingleFlightRunner(
	run: (path: string) => Promise<void>,
	onSkip: (path: string) => void
): (path: string) => Promise<void> {
	const inFlight = new Set<string>();
	return async (path) => {
		if (inFlight.has(path)) {
			onSkip(path);
			return;
		}
		inFlight.add(path);
		try {
			await run(path);
		} finally {
			inFlight.delete(path);
		}
	};
}

// =============================================================================
// APPROVALS (#116)
// =============================================================================

/** A scheduled note the agent does not run, and why. The reason completes "not running <path>: …". */
export interface SkippedNote {
	path: string;
	reason: string;
}

const SKIP_REASONS = {
	"not-approved": "it is not approved",
	changed: "it changed since it was approved",
} as const;

/**
 * Which scheduled notes to arm: those with an approval that matches the note
 * as it is now. The rest are skipped with the reason.
 */
export function planRegistrations(
	notes: ScheduledNote[],
	approvals: VaultApprovals
): { register: ScheduledNote[]; skipped: SkippedNote[] } {
	const register: ScheduledNote[] = [];
	const skipped: SkippedNote[] = [];
	for (const note of notes) {
		const state = classifyScheduleApproval(approvals, note.path, note.hash);
		if (state === "approved") {
			register.push(note);
		} else {
			skipped.push({ path: note.path, reason: SKIP_REASONS[state] });
		}
	}
	return { register, skipped };
}

/**
 * Wrap `run` so a due note runs only if it is approved as it is at that
 * moment. The rescan that armed it may be minutes old: the note is read again,
 * and so are the approvals, so an edit, a deletion or a revoke since then is
 * honoured. `run` gets the content that was checked, so what runs is what was
 * approved. A note that may not run is passed to `onRefuse`.
 */
export function createApprovedRunner(options: {
	readNote: (path: string) => Promise<{ note: ScheduledNote; content: string }>;
	approvals: () => Promise<VaultApprovals>;
	run: (path: string, content: string) => Promise<void>;
	onRefuse: (path: string, reason: string) => void;
}): (path: string) => Promise<void> {
	return async (path) => {
		let content: string;
		try {
			const read = await options.readNote(path);
			const state = classifyScheduleApproval(await options.approvals(), path, read.note.hash);
			if (state !== "approved") {
				options.onRefuse(path, SKIP_REASONS[state]);
				return;
			}
			content = read.content;
		} catch (err) {
			options.onRefuse(path, errorMessage(err));
			return;
		}
		await options.run(path, content);
	};
}

/**
 * Reports what a rescan left unarmed: each skipped note with its reason, and
 * a plain line when nothing will run at all. The agent rescans every few
 * minutes, so the same state is reported once and again only when it changes.
 */
export function createSkipReporter(
	write: (line: string) => void
): (state: { registered: number; skipped: SkippedNote[] }) => void {
	let last: string | undefined;
	return ({ registered, skipped }) => {
		const signature = JSON.stringify([registered === 0, skipped.map((s) => [s.path, s.reason])]);
		if (signature === last) return;
		last = signature;

		for (const note of skipped) {
			write(`not running ${note.path}: ${note.reason}`);
		}
		if (registered > 0) return;
		write(
			skipped.length > 0
				? "no scheduled workflow is approved, so nothing will run; approve one with: vaultore schedules approve <note.md>"
				: "no scheduled workflow found, so nothing will run"
		);
	};
}
