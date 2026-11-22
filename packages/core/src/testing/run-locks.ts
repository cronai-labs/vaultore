/**
 * Run locks for the unit tests' fake platforms: held in memory, refused while
 * held, as `acquireRunLock` behaves on disk. Not part of the published bundle.
 */

import { RunLockHeldError } from "../lock/run-lock";
import type { LeftBehind, RunLock } from "../lock/run-lock";

export interface MemoryRunLocks {
	/** The method a fake PlatformAdapter offers as `acquireRunLock`. */
	acquireRunLock(notePath: string): Promise<RunLock>;
	/** The notes whose lock is held now. */
	readonly held: ReadonlySet<string>;
	/** What the next taking reports as left behind, as a stale lock would. */
	leaveBehind(entry: LeftBehind): void;
}

export function memoryRunLocks(by = "a test"): MemoryRunLocks {
	const held = new Set<string>();
	let pending: LeftBehind[] = [];
	return {
		held,
		leaveBehind(entry: LeftBehind) {
			pending.push(entry);
		},
		async acquireRunLock(notePath: string) {
			if (held.has(notePath)) {
				throw new RunLockHeldError(
					notePath,
					{ pid: process.pid, host: "test", since: new Date(0).toISOString(), by },
					`${notePath} is already being run by ${by}`
				);
			}
			held.add(notePath);
			const leftBehind = pending;
			pending = [];
			let released = false;
			return {
				leftBehind,
				release: async () => {
					if (released) return;
					released = true;
					held.delete(notePath);
				},
			};
		},
	};
}
