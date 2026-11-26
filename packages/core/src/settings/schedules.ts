import { posix, win32 } from "node:path";
import { userStateDirectory } from "../lock/run-lock";
import type { ScheduleApproval } from "../scheduler/approvals";
import { VaultStateStore, isRecord } from "./vault-state-store";
import type { VaultStateStoreOps } from "./vault-state-store";

/**
 * Which scheduled notes run on this computer, and in which runner (#301): one
 * approval per note, naming the runner that owns it, in one file both runners
 * read. Kept in the user tree, not in the vault: consent to run a note
 * unattended must not be something a synced file can grant (#171, #276).
 *
 * Only the owner arms a note; the other runner shows it as delegated and
 * never fires it, so the two runners on one computer cannot both schedule it.
 */

/** The runners a note's schedule can be delegated to. cronai.app may join them. */
export type ScheduleOwner = "obsidian" | "agent";

export const SCHEDULE_OWNERS: readonly ScheduleOwner[] = ["obsidian", "agent"];

/** A note approved to run on schedule, by the runner that owns it. */
export interface NoteApproval extends ScheduleApproval {
	owner: ScheduleOwner;
}

/** One vault's schedules on this computer. */
export interface VaultSchedules {
	/** The plugin's "Run scheduled workflows": whether it runs the notes it owns. */
	obsidianScheduling: boolean;
	/** Vault-relative note path to its approval. */
	notes: Record<string, NoteApproval>;
}

export const SCHEDULES_FILE = "schedules.json";

/** `~/.config/vaultore/schedules.json`, `%APPDATA%\vaultore\schedules.json` on Windows. */
export function schedulesPath(
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
	accountHome?: () => string
): string {
	return userStateDirectory(SCHEDULES_FILE, "schedule approvals", platform, env, ...(accountHome ? [accountHome] : []));
}

function invalidApproval(value: unknown): string | undefined {
	if (!isRecord(value)) return "is not an approval";
	if (!SCHEDULE_OWNERS.includes(value["owner"] as ScheduleOwner)) return "names no runner that owns it";
	for (const key of ["schedule", "hash", "approvedAt"]) {
		if (typeof value[key] !== "string") return "is incomplete";
	}
	return undefined;
}

export interface SchedulesStoreOptions extends VaultStateStoreOps {
	/** The file. Default: `schedulesPath()`. Tests pass their own. */
	path?: string;
}

/** The store of every vault's schedules on this computer, in one file. */
export function schedulesStore(options: SchedulesStoreOptions = {}): VaultStateStore<VaultSchedules> {
	const { path, ...ops } = options;
	return new VaultStateStore<VaultSchedules>(
		{
			file: path ?? schedulesPath(),
			format: "vaultore.schedules",
			version: 1,
			what: "schedules file",
			invalid: (entry, vault) => {
				if (!isRecord(entry) || typeof entry["obsidianScheduling"] !== "boolean" || !isRecord(entry["notes"])) {
					return `the entry for vault ${vault} is incomplete`;
				}
				for (const [note, approval] of Object.entries(entry["notes"])) {
					const why = invalidApproval(approval);
					if (why !== undefined) return `the approval of ${note} in vault ${vault} ${why}`;
				}
				return undefined;
			},
			copy: (entry) => ({
				obsidianScheduling: entry?.obsidianScheduling ?? false,
				// Without a prototype: a note path such as "__proto__" is an entry like any other.
				notes: Object.assign(Object.create(null) as Record<string, NoteApproval>, entry?.notes),
			}),
			isEmpty: (entry) => !entry.obsidianScheduling && Object.keys(entry.notes).length === 0,
		},
		ops
	);
}

// =============================================================================
// THE AGENT'S APPROVALS OF 0.4.x
// =============================================================================

/** A vault's approvals in the agent's `approvals.json` of 0.4.x. */
type LegacyApprovals = Record<string, ScheduleApproval>;

/**
 * Where `vaultore agent` of 0.4.x kept its approvals: `$XDG_CONFIG_HOME/vaultore`
 * when that is absolute, else `~/.config/vaultore` from `$HOME`; on Windows
 * `%APPDATA%\vaultore`. Undefined where there was none.
 */
export function legacyApprovalsPath(inputs: {
	env: Readonly<Record<string, string | undefined>>;
	platform: NodeJS.Platform;
	/** `os.homedir()`, which follows `$HOME`. */
	homedir: string;
}): string | undefined {
	const { env, platform, homedir } = inputs;
	if (platform === "win32") {
		const appData = env["APPDATA"];
		return appData ? win32.join(appData, "vaultore", "approvals.json") : undefined;
	}
	const xdg = env["XDG_CONFIG_HOME"];
	if (xdg && posix.isAbsolute(xdg)) return posix.join(xdg, "vaultore", "approvals.json");
	return homedir ? posix.join(homedir, ".config", "vaultore", "approvals.json") : undefined;
}

function legacyApprovalsStore(file: string, ops: VaultStateStoreOps): VaultStateStore<LegacyApprovals> {
	return new VaultStateStore<LegacyApprovals>(
		{
			file,
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
			copy: (approvals) => Object.assign(Object.create(null) as LegacyApprovals, approvals),
			isEmpty: (approvals) => Object.keys(approvals).length === 0,
		},
		ops
	);
}

export interface OpenSchedulesOptions extends SchedulesStoreOptions {
	/** The agent's approvals of 0.4.x, from `legacyApprovalsPath()`; undefined for none. */
	legacyApprovals?: string;
	/** Told when they were copied in. */
	onImported?: (from: string, to: string) => void;
}

/**
 * The schedules store, with the agent's approvals of 0.4.x copied in once, as
 * notes the agent owns. Both runners open it this way, so whichever runs first
 * after an upgrade carries them over. A note approved here already keeps its
 * approval. The old file is left as it is.
 */
export async function openSchedules(options: OpenSchedulesOptions = {}): Promise<VaultStateStore<VaultSchedules>> {
	const { legacyApprovals, onImported, ...storeOptions } = options;
	const store = schedulesStore(storeOptions);
	if (legacyApprovals !== undefined) {
		const { path: _path, ...ops } = storeOptions;
		const legacy = legacyApprovalsStore(legacyApprovals, ops);
		const copied = await store.importFrom(legacy, (into, approvals) => {
			for (const [note, approval] of Object.entries(approvals)) {
				if (Object.prototype.hasOwnProperty.call(into.notes, note)) continue;
				into.notes[note] = { owner: "agent", hash: approval.hash, schedule: approval.schedule, approvedAt: approval.approvedAt };
			}
		});
		if (copied) onImported?.(legacy.file, store.file);
	}
	return store;
}

// =============================================================================
// WHETHER A NOTE RUNS
// =============================================================================

/** A scheduled note as it is now. */
export interface ScheduledNoteNow {
	path: string;
	schedule: string;
	/** `grantHash`: the front matter and each cell's attributes and source. */
	hash: string;
}

export type NoteScheduleState =
	/** This runner owns it, and the approval applies to the note as it is: it runs. */
	| { state: "approved"; approval: NoteApproval }
	/** Nobody approved it on this computer. */
	| { state: "not-approved" }
	/** The other runner owns it. */
	| { state: "delegated"; approval: NoteApproval }
	/** This runner owns it, but the note changed since (the agent: its content; the plugin: its schedule). */
	| { state: "changed"; approval: NoteApproval }
	/** The plugin owns it, and "Run scheduled workflows" is off. */
	| { state: "off"; approval: NoteApproval };

/**
 * Whether `runner` runs `note` on schedule. The agent's approval binds the
 * note's content (its schedule included); the plugin's, the schedule, while
 * "Run scheduled workflows" is on.
 */
export function noteScheduleState(runner: ScheduleOwner, schedules: VaultSchedules, note: ScheduledNoteNow): NoteScheduleState {
	if (!Object.prototype.hasOwnProperty.call(schedules.notes, note.path)) return { state: "not-approved" };
	const approval = schedules.notes[note.path] as NoteApproval;
	if (approval.owner !== runner) return { state: "delegated", approval };
	if (runner === "agent") return approval.hash === note.hash ? { state: "approved", approval } : { state: "changed", approval };
	if (approval.schedule !== note.schedule) return { state: "changed", approval };
	return schedules.obsidianScheduling ? { state: "approved", approval } : { state: "off", approval };
}

/** Approves `note` to run on schedule in `owner`, replacing any approval it had. */
export function approveNote(schedules: VaultSchedules, note: ScheduledNoteNow, owner: ScheduleOwner, now: Date = new Date()): void {
	schedules.notes[note.path] = { owner, schedule: note.schedule, hash: note.hash, approvedAt: now.toISOString() };
}

/** Takes a note's approval away. Returns whether it had one. */
export function revokeNote(schedules: VaultSchedules, path: string): boolean {
	if (!Object.prototype.hasOwnProperty.call(schedules.notes, path)) return false;
	delete schedules.notes[path];
	return true;
}

/** How a runner is named to people. */
export function ownerName(owner: ScheduleOwner): string {
	return owner === "agent" ? "vaultore agent" : "Obsidian";
}
