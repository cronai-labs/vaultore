/**
 * `vaultore permissions`: the answers kept for runs started by hand (#322).
 *
 * Kept out of cli.ts so it can be unit tested — cli.ts runs main() on import.
 */

import { ANSWER_PERMISSION_KEYS, forgetAnswers, readMachineSettings, writeMachineSettings } from "@vaultore/core";
import type { AnswerPermissionKey, LockWait, VaultAnswers, VaultStateStore } from "@vaultore/core";

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

/**
 * `vaultore permissions share [on | off]`: shows, or sets for this account on
 * this computer, whether Obsidian and the CLI share the answers given for
 * runs started by hand (#331), in the file both runners read. Returns the
 * line to print; any other value throws.
 */
export async function shareAnswersSetting(value: string | undefined, path: string, wait?: LockWait): Promise<string> {
	if (value !== undefined && value !== "on" && value !== "off") {
		throw new Error(`permissions share takes on or off, got '${value}'`);
	}
	const settings =
		value === undefined
			? await readMachineSettings({ path })
			: await writeMachineSettings({ shareAnswers: value === "on" ? undefined : false }, { path, ...(wait ? { wait } : {}) });
	return settings.shareAnswers === false
		? `permission answers are not shared: Obsidian and vaultore each keep their own (set in ${path})`
		: `permission answers are shared by Obsidian and vaultore${value === "on" || settings.shareAnswers === undefined ? " (the default)" : ""}`;
}
