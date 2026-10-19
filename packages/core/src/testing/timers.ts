/**
 * The process's own timers as a `Timers`, for tests and the integration
 * platform, which run in Node. Not part of the published bundle.
 */

import type { Timers } from "../types";

export const nodeTimers: Timers = {
	setTimeout: (callback, ms) => setTimeout(callback, ms),
	clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
	setInterval: (callback, ms) => setInterval(callback, ms),
	clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
};
