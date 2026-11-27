import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Writes an in-memory vault's files under `root`, so that what is mounted for
 * a cell, which the executor reads from the host's folder (#336), matches
 * what the test's platform holds.
 */
export function mirrorToDisk(root: string, files: Record<string, string>): void {
	for (const [path, content] of Object.entries(files)) {
		const target = join(root, path);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, content);
	}
}
