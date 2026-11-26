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

import { dirname, posix, resolve, win32 } from "node:path";
import { VaultStateStore, isRecord, userStateDirectory } from "@vaultore/core";
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
	/** The account's home directory; read from the user database by default, as core does. */
	accountHome?: () => string;
}

/**
 * The folder the agent's approvals are kept in: `--state-dir`, else VaultOre's
 * folder for this user, where the run locks, the schedule record and the
 * shared settings are too (core's `userStateDirectory`: `~/.config/vaultore`
 * from the account's home directory, `%APPDATA%\vaultore` on Windows).
 * Neither `$HOME` nor `$XDG_CONFIG_HOME` moves it (#277).
 */
export function resolveStateDir(inputs: StateDirInputs): string {
	const { flag, env, platform, accountHome } = inputs;

	if (flag !== undefined) {
		if (typeof flag !== "string" || flag.trim() === "") {
			throw new Error("--state-dir requires a value");
		}
		return resolve(flag);
	}
	return dirname(
		userStateDirectory(APPROVALS_FILE, "schedule approvals", platform, env, ...(accountHome ? [accountHome] : []))
	);
}

export interface LegacyStateDirInputs {
	env: Readonly<Record<string, string | undefined>>;
	platform: NodeJS.Platform;
	/** `os.homedir()`, which follows `$HOME`. */
	homedir: string;
}

/**
 * Where the approvals were kept before they moved beside the rest (#277):
 * `$XDG_CONFIG_HOME/vaultore` when that is absolute, else `~/.config/vaultore`
 * from `$HOME`; on Windows the same folder as now. Undefined where there was
 * none.
 */
export function legacyStateDir(inputs: LegacyStateDirInputs): string | undefined {
	const { env, platform, homedir } = inputs;
	if (platform === "win32") {
		const appData = env["APPDATA"];
		return appData ? win32.join(appData, "vaultore") : undefined;
	}
	const xdg = env["XDG_CONFIG_HOME"];
	if (xdg && posix.isAbsolute(xdg)) return posix.join(xdg, "vaultore");
	return homedir ? posix.join(homedir, ".config", "vaultore") : undefined;
}

/**
 * The approvals file of this machine, with the approvals kept where they were
 * before copied in once (#277): only while the new file does not exist, so a
 * revoke after the move stays revoked. The old file is left as it is, and no
 * longer read. With `--state-dir`, the folder given is used as it is.
 */
export async function openApprovalStore(
	stateDir: string,
	legacyDir: string | undefined,
	ops: ApprovalStoreOps & { onImported?: (from: string, to: string) => void } = {}
): Promise<ApprovalStore> {
	const store = new ApprovalStore(stateDir, ops);
	if (legacyDir !== undefined && resolve(legacyDir) !== resolve(stateDir)) {
		const legacy = new ApprovalStore(legacyDir, ops);
		if (await store.importOnce(legacy)) ops.onImported?.(legacy.file, store.file);
	}
	return store;
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
