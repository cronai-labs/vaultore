/**
 * Run locks for the unit tests' fake platforms: held in memory, refused while
 * held, as `acquireRunLock` behaves on disk. Not part of the published bundle.
 */

import { RunLockHeldError } from "../lock/run-lock";

export interface MemoryRunLocks {
	/** The method a fake PlatformAdapter offers as `acquireRunLock`. */
	acquireRunLock(notePath: string): Promise<() => Promise<void>>;
	/** The notes whose lock is held now. */
	readonly held: ReadonlySet<string>;
}

export function memoryRunLocks(by = "a test"): MemoryRunLocks {
	const held = new Set<string>();
	return {
		held,
		async acquireRunLock(notePath: string) {
			if (held.has(notePath)) {
				throw new RunLockHeldError(
					notePath,
					{ pid: process.pid, host: "test", since: new Date(0).toISOString(), by },
					`${notePath} is already being run by ${by}`
				);
			}
			held.add(notePath);
			let released = false;
			return async () => {
				if (released) return;
				released = true;
				held.delete(notePath);
			};
		},
	};
}
