/**
 * @vaultore/core - Schedule approvals
 *
 * Consent to run a scheduled note unattended, bound to what the note runs:
 * its path and the hash permission decisions use (`grantHash`, the front
 * matter and each cell's attributes and source). Where approvals are kept,
 * which runner owns each, and whether a note still has one:
 * `settings/schedules.ts` (#301).
 */

export interface ScheduleApproval {
  /** `grantHash` of the note when it was approved. */
  hash: string;
  /**
   * The schedule approved. The agent does not compare it, as the hash covers
   * it; the plugin's approval binds the schedule alone.
   */
  schedule: string;
  /** When the approval was given (ISO 8601), for display. */
  approvedAt: string;
}
