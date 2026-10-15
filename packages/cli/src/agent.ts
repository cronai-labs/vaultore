/**
 * @vaultore/cli - agent helpers
 *
 * Kept out of cli.ts so they can be unit tested — cli.ts runs main() on
 * import.
 */

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
