/**
 * `vaultore permissions`: the answers kept for runs started by hand (#322).
 *
 * Kept out of cli.ts so it can be unit tested — cli.ts runs main() on import.
 */

import { ANSWER_PERMISSION_KEYS, forgetAnswers } from "@vaultore/core";
import type { AnswerPermissionKey, VaultAnswers, VaultStateStore } from "@vaultore/core";

/**
 * The permissions named on the command line, or all of them when none is.
 * Throws on a name VaultOre does not know, naming those it does.
 */
export function permissionNamesFrom(names: readonly string[]): AnswerPermissionKey[] {
	if (names.length === 0) return [...ANSWER_PERMISSION_KEYS];
	const known = ANSWER_PERMISSION_KEYS as readonly string[];
	const unknown = names.filter((name) => !known.includes(name));
	if (unknown.length > 0) {
		throw new Error(`no such permission: ${unknown.join(", ")}; the permissions are ${ANSWER_PERMISSION_KEYS.join(", ")}`);
	}
	return [...new Set(names)] as AnswerPermissionKey[];
}

/** Forgets a note's kept answers and says what it forgot. */
export async function forgetNoteAnswers(options: {
	store: VaultStateStore<VaultAnswers>;
	vaultKey: string;
	notePath: string;
	names: readonly AnswerPermissionKey[];
}): Promise<string> {
	const removed = await forgetAnswers(options.store, options.vaultKey, options.notePath, options.names);
	if (removed.length === 0) {
		return `no answers kept for ${options.notePath} on this computer${options.names.length < ANSWER_PERMISSION_KEYS.length ? ` for ${options.names.join(", ")}` : ""}; nothing to forget`;
	}
	return `forgot the answers to ${removed.join(", ")} for ${options.notePath}; the next run started by hand asks again (in ${options.store.file})`;
}
