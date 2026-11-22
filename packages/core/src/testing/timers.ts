/**
 * The process's own timers as a `Timers`, for tests and the integration
 * platform, which run in Node. Not part of the published bundle.
 *
 * Imported from `node:timers` rather than used as globals: the community
 * directory's review lints the repository's source, this file included, and
 * flags a global timer call for popout windows, which Node does not have.
 */

import { clearInterval, clearTimeout, setInterval, setTimeout } from "node:timers";

import type { Timers } from "../types";

export const nodeTimers: Timers = {
	setTimeout: (callback, ms) => setTimeout(callback, ms),
	clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
	setInterval: (callback, ms) => setInterval(callback, ms),
	clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
};
