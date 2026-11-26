/**
 * @vaultore/cli - how long a command waits for a shared file another process
 * is changing: a moment, then it is refused naming that process. Node's own
 * timer: the CLI has no window.
 */

import { setTimeout } from "node:timers";
import { SHORT_LOCK_WAIT_MS } from "@vaultore/core";
import type { LockWait } from "@vaultore/core";

export const SHORT_WAIT: LockWait = {
	timers: { setTimeout: (callback, ms) => setTimeout(callback, ms) },
	ms: SHORT_LOCK_WAIT_MS,
};
