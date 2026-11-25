/**
 * @vaultore/cli - where the agent's schedule approvals are kept
 *
 * `vaultore agent` runs a scheduled note only while an approval for it exists
 * (#116). The approvals are kept outside the vault, on this machine: whatever
 * is inside a vault can arrive through sync, and consent must not be something
 * a synced file can grant. One file holds every vault's approvals, keyed by
 * the vault's real path.
 *
 * What an approval is, and whether a note still has it, is core's
 * (`classifyScheduleApproval`); this file only reads and writes the list.
 */

import { posix, resolve, win32 } from "node:path";
import { VaultStateStore, isRecord } from "@vaultore/core";
import type { ScheduleApproval, VaultStateStoreOps } from "@vaultore/core";

export { vaultKeyFor } from "@vaultore/core";

const APPROVALS_FILE = "approvals.json";

/** A vault's approvals: vault-relative note path to approval. */
export type VaultApprovals = Record<string, ScheduleApproval>;

// =============================================================================
// WHERE
// =============================================================================

export interface StateDirInputs {
	/** The value of `--state-dir`, when given. */
	flag?: string | boolean;
	env: Readonly<Record<string, string | undefined>>;
	platform: NodeJS.Platform;
	homedir: string;
}

/**
 * The folder VaultOre keeps this machine's own state in:
 * `--state-dir`, else `%APPDATA%\vaultore` on Windows, else
 * `$XDG_CONFIG_HOME/vaultore`, else `~/.config/vaultore`.
 *
 * A relative or empty `XDG_CONFIG_HOME` is ignored, as the XDG base directory
 * specification says: taken as is, the approvals would move with the directory
 * the command runs in.
 */
export function resolveStateDir(inputs: StateDirInputs): string {
	const { flag, env, platform, homedir } = inputs;

	if (flag !== undefined) {
		if (typeof flag !== "string" || flag.trim() === "") {
			throw new Error("--state-dir requires a value");
		}
		return resolve(flag);
	}

	if (platform === "win32") {
		const appData = env["APPDATA"];
		if (!appData) {
			throw new Error("APPDATA is not set, so there is no place for approvals: pass --state-dir <dir>");
		}
		return win32.join(appData, "vaultore");
	}

	const xdg = env["XDG_CONFIG_HOME"];
	if (xdg && posix.isAbsolute(xdg)) return posix.join(xdg, "vaultore");
	if (!homedir) {
		throw new Error("No home directory, so there is no place for approvals: pass --state-dir <dir>");
	}
	return posix.join(homedir, ".config", "vaultore");
}

// =============================================================================
// THE FILE
// =============================================================================

export type ApprovalStoreOps = VaultStateStoreOps;

/**
 * The agent's approvals, one file for every vault (core's `VaultStateStore`):
 * read and changed under a lock, written whole. The file need not exist: then
 * nothing is approved.
 */
export class ApprovalStore extends VaultStateStore<VaultApprovals> {
	constructor(stateDir: string, ops: ApprovalStoreOps = {}) {
		super(
			{
				file: resolve(stateDir, APPROVALS_FILE),
				format: "vaultore.schedule-approvals",
				version: 1,
				what: "approvals file",
				invalid: (approvals, vault) => {
					if (!isRecord(approvals)) return `the entry for vault ${vault} is not a list`;
					for (const [path, approval] of Object.entries(approvals)) {
						if (
							!isRecord(approval) ||
							typeof approval["hash"] !== "string" ||
							typeof approval["schedule"] !== "string" ||
							typeof approval["approvedAt"] !== "string"
						) {
							return `the approval of ${path} in vault ${vault} is incomplete`;
						}
					}
					return undefined;
				},
				// Without a prototype, so that a note path such as "__proto__" is
				// stored as an entry like any other.
				copy: (approvals) => Object.assign(Object.create(null) as VaultApprovals, approvals),
				isEmpty: (approvals) => Object.keys(approvals).length === 0,
			},
			{
				...ops,
				onStaleLock:
					ops.onStaleLock ??
					((holder, lockPath, why) => {
						process.stderr.write(
							`[vaultore] removed the lock ${lockPath}: process ${holder.pid}, which took it at ${holder.since}, ${why}\n`
						);
					}),
			}
		);
	}
}
