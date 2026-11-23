/**
 * A schedule record for the unit tests' fake platforms: held in memory,
 * refusing a slot claimed before, as `claimSlot` behaves on disk. Not part of
 * the published bundle.
 */

import { SlotTakenError } from "../scheduler/slot-record";
import type { SlotClaim, SlotOutcome } from "../scheduler/slot-record";
import type { ScheduledSlot } from "../types";

export interface MemorySlotRecord {
	/** The method a fake PlatformAdapter offers as `claimSlot`. */
	claimSlot(notePath: string, slot: ScheduledSlot): Promise<SlotClaim>;
	/** Claimed slots as "note slot", with their outcome once written. */
	readonly slots: Map<string, SlotOutcome | undefined>;
}

export function memorySlotRecord(by = "a test"): MemorySlotRecord {
	const slots = new Map<string, SlotOutcome | undefined>();
	return {
		slots,
		async claimSlot(notePath, scheduled) {
			const key = `${notePath} ${scheduled.slot.toISOString()}`;
			if (slots.has(key)) {
				throw new SlotTakenError(
					notePath,
					scheduled.slot,
					undefined,
					`The ${scheduled.slot.toISOString()} run of ${notePath} was claimed by ${by}. Nothing was run`
				);
			}
			slots.set(key, undefined);
			let finished = false;
			return {
				slot: scheduled.slot,
				async finish(outcome) {
					if (finished) return;
					finished = true;
					slots.set(key, outcome);
				},
			};
		},
	};
}
