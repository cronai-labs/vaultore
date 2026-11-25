import { userStateDirectory } from "../lock/run-lock";
import { VaultStateStore, isRecord } from "./vault-state-store";
import type { VaultStateStoreOps } from "./vault-state-store";

/**
 * The Obsidian plugin's scheduling consent for one vault on this machine:
 * whether "Run scheduled workflows" is on, and the notes approved, each with
 * the exact schedule approved. Kept in the user tree, not in the plugin's
 * `data.json`: a sync that carries `data.json` would otherwise turn scheduling
 * on and approve notes on every machine with the vault (#276). Separate from
 * the agent's approvals (#171), in a file of its own.
 */
export interface PluginSchedules {
	runScheduledWorkflows: boolean;
	/** Vault-relative note path to the schedule approved for it. */
	approvals: Record<string, string>;
}

export const PLUGIN_SCHEDULES_FILE = "obsidian-schedules.json";

/** Where the plugin's scheduling consent lives: `~/.config/vaultore/obsidian-schedules.json`. */
export function pluginSchedulesPath(
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
	accountHome?: () => string
): string {
	return userStateDirectory(PLUGIN_SCHEDULES_FILE, "scheduling approvals", platform, env, ...(accountHome ? [accountHome] : []));
}

export interface PluginSchedulesOptions extends VaultStateStoreOps {
	/** The file. Default: `pluginSchedulesPath()`. Tests pass their own. */
	path?: string;
}

/** The store of the plugin's scheduling consent, every vault's in one file. */
export function pluginSchedulesStore(options: PluginSchedulesOptions = {}): VaultStateStore<PluginSchedules> {
	const { path, ...ops } = options;
	return new VaultStateStore<PluginSchedules>(
		{
			file: path ?? pluginSchedulesPath(),
			format: "vaultore.obsidian-schedules",
			version: 1,
			what: "scheduling approvals file",
			invalid: (entry, vault) => {
				if (!isRecord(entry) || typeof entry["runScheduledWorkflows"] !== "boolean" || !isRecord(entry["approvals"])) {
					return `the entry for vault ${vault} is incomplete`;
				}
				for (const [note, schedule] of Object.entries(entry["approvals"])) {
					if (typeof schedule !== "string") return `the approval of ${note} in vault ${vault} is not a schedule`;
				}
				return undefined;
			},
			copy: (entry) => ({
				runScheduledWorkflows: entry?.runScheduledWorkflows ?? false,
				// Without a prototype: a note path such as "__proto__" is an entry like any other.
				approvals: Object.assign(Object.create(null) as Record<string, string>, entry?.approvals),
			}),
			isEmpty: (entry) => !entry.runScheduledWorkflows && Object.keys(entry.approvals).length === 0,
		},
		ops
	);
}
