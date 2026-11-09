/**
 * @vaultore/core - Schedule approvals
 *
 * Consent to run a scheduled note unattended, bound to what the note runs:
 * its path and the hash permission decisions use (`grantHash`, the front
 * matter and each cell's attributes and source). Where a host keeps its
 * approvals is the host's matter; this file only says what one is and whether
 * a note still has it.
 */

export interface ScheduleApproval {
  /** `grantHash` of the note when it was approved. */
  hash: string;
  /**
   * The schedule approved, for display. Not compared: the schedule is part of
   * the front matter, so the hash already covers it.
   */
  schedule: string;
  /** When the approval was given (ISO 8601), for display. */
  approvedAt: string;
}

export type ScheduleApprovalState =
  /** Approved, and the note is what was approved. */
  | "approved"
  /** Nobody approved a note at this path. */
  | "not-approved"
  /** Approved once; its front matter or a cell changed since. */
  | "changed";

/**
 * Whether the note at `path`, whose content hashes to `hash`, may run on its
 * schedule under `approvals` (note path to approval).
 */
export function classifyScheduleApproval(
  approvals: Readonly<Record<string, ScheduleApproval>>,
  path: string,
  hash: string
): ScheduleApprovalState {
  // Own properties only: a note path is text from the vault, and "constructor"
  // must not find Object.prototype's.
  if (!Object.prototype.hasOwnProperty.call(approvals, path)) return "not-approved";
  return approvals[path]?.hash === hash ? "approved" : "changed";
}
