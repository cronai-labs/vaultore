/**
 * @vaultore/cli - `vaultore permissions other-devices`
 *
 * Whether the answers to a note's `ask` permissions given on other devices,
 * or before answers carried a device, apply on this one (#284). Kept in the
 * shared settings outside the vault, so a synced file cannot turn it on; the
 * plugin's "Permission answers from other devices" is the same setting.
 */

import { readMachineSettings, writeMachineSettings } from "@vaultore/core";

/**
 * Shows the setting (`value` undefined) or sets it: `apply` turns it on,
 * `ask` back off, the default. Returns the line to print; another value throws.
 */
export async function otherDevices(value: string | undefined, path: string): Promise<string> {
	if (value !== undefined && value !== "apply" && value !== "ask") {
		throw new Error(`other-devices takes apply or ask, got '${value}'`);
	}
	const settings =
		value === undefined
			? await readMachineSettings({ path })
			: await writeMachineSettings({ decisionsFromOtherDevices: value === "apply" ? true : undefined }, { path });
	return settings.decisionsFromOtherDevices === true
		? `permission answers from other devices: apply here (set in ${path})`
		: "permission answers from other devices: ask again here (the default)";
}
