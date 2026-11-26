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
	/** What unattended runs of the note get (#299). Absent only on an approval imported from 0.4.x. */
	permissions?: ApprovedPermissions;
}

/** One vault's schedules on this computer. */
export interface VaultSchedules {
	/** The plugin's "Run scheduled workflows": whether it runs the notes it owns. */
	obsidianScheduling: boolean;
	/**
	 * When "Run scheduled workflows" was last turned on, ISO 8601; absent
	 * while it is off. The notes Obsidian runs are scheduled only since then,
	 * so no run before it is missed (#308).
	 */
	obsidianSchedulingSince?: string;
	/**
	 * What the plugin's approvals bind: the note's content (`strict`, the
	 * default) or only its schedule and permissions (`narrow`). The agent's
	 * always bind the content.
	 */
	obsidianBinding: "strict" | "narrow";
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
	const permissions = value["permissions"];
	if (permissions === undefined) return undefined;
	if (!isRecord(permissions)) return "holds no permissions";
	for (const key of APPROVAL_PERMISSION_KEYS) {
		const held = permissions[key];
		if (!isRecord(held) || (held["value"] !== "allow" && held["value"] !== "deny") || (held["source"] !== "frontmatter" && held["source"] !== "answer")) {
			return `holds no valid ${key} permission`;
		}
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
				const since = entry["obsidianSchedulingSince"];
				if (since !== undefined && (typeof since !== "string" || Number.isNaN(Date.parse(since)))) {
					return `the entry for vault ${vault} has no valid time for when scheduling was turned on`;
				}
				const binding = entry["obsidianBinding"];
				if (binding !== undefined && binding !== "strict" && binding !== "narrow") {
					return `the entry for vault ${vault} names no binding VaultOre knows`;
				}
				for (const [note, approval] of Object.entries(entry["notes"])) {
					const why = invalidApproval(approval);
					if (why !== undefined) return `the approval of ${note} in vault ${vault} ${why}`;
				}
				return undefined;
			},
			copy: (entry) => ({
				obsidianScheduling: entry?.obsidianScheduling ?? false,
				...(entry?.obsidianSchedulingSince !== undefined ? { obsidianSchedulingSince: entry.obsidianSchedulingSince } : {}),
				// Missing in a file written before the setting: strict.
				obsidianBinding: entry?.obsidianBinding ?? "strict",
				// Without a prototype: a note path such as "__proto__" is an entry like any other.
				notes: Object.assign(Object.create(null) as Record<string, NoteApproval>, entry?.notes),
			}),
			isEmpty: (entry) => !entry.obsidianScheduling && entry.obsidianBinding === "strict" && Object.keys(entry.notes).length === 0,
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
	/**
	 * Told, once per change, that the old file changed since it was copied
	 * (a 0.4.x agent ran again): it is not copied again (#309).
	 */
	onLegacyChanged?: (from: string) => void;
}

/**
 * The schedules store, with the agent's approvals of 0.4.x copied in once, as
 * notes the agent owns. Both runners open it this way, so whichever runs first
 * after an upgrade carries them over. A note approved here already keeps its
 * approval. The old file is left as it is.
 */
export async function openSchedules(options: OpenSchedulesOptions = {}): Promise<VaultStateStore<VaultSchedules>> {
	const { legacyApprovals, onImported, onLegacyChanged, ...storeOptions } = options;
	const store = schedulesStore(storeOptions);
	if (legacyApprovals !== undefined) {
		const { path: _path, ...ops } = storeOptions;
		const legacy = legacyApprovalsStore(legacyApprovals, ops);
		const copied = await store.importFrom(legacy, (into, approvals) => {
			for (const [note, approval] of Object.entries(approvals)) {
				if (Object.prototype.hasOwnProperty.call(into.notes, note)) continue;
				into.notes[note] = { owner: "agent", hash: approval.hash, schedule: approval.schedule, approvedAt: approval.approvedAt };
			}
		}, onLegacyChanged);
		if (copied) onImported?.(legacy.file, store.file);
	}
	return store;
}

// =============================================================================
// WHAT AN APPROVAL HOLDS
// =============================================================================

/** The four permissions, in the order they are shown. */
export const APPROVAL_PERMISSION_KEYS = ["network", "buildNetwork", "vaultRead", "vaultWrite"] as const;
export type ApprovalPermissionKey = (typeof APPROVAL_PERMISSION_KEYS)[number];

/** A permission as an unattended run of the note gets it (#299). */
export interface ApprovedPermission {
	value: "allow" | "deny";
	/** The frontmatter said so, or the person answered an `ask` when approving. */
	source: "frontmatter" | "answer";
}

export type ApprovedPermissions = Record<ApprovalPermissionKey, ApprovedPermission>;

/** What the frontmatter says of each permission, defaults filled in. */
export type NotePermissions = Record<ApprovalPermissionKey, "allow" | "deny" | "ask">;

/**
 * What an approval binds. `content`: the frontmatter and every cell, as
 * `grantHash` covers them. `schedule`: only the schedule and the four
 * permissions; cells, image, engine and limits may change, as the cells' code
 * may (the plugin's narrow binding).
 */
export type ApprovalBinding = "content" | "schedule";

/** The binding of a note's owner: the agent's is always the content; the plugin's, its setting. */
export function bindingOf(schedules: VaultSchedules, owner: ScheduleOwner): ApprovalBinding {
	return owner === "obsidian" && schedules.obsidianBinding === "narrow" ? "schedule" : "content";
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
	/** Its frontmatter's permissions, defaults filled in. */
	permissions: NotePermissions;
}

/** How one permission compares with what the note's approval holds. */
export interface PermissionReview {
	key: ApprovalPermissionKey;
	/** What the frontmatter says now. */
	now: "allow" | "deny" | "ask";
	/** What the approval holds; undefined when there is none, or it is from 0.4.x and the note changed since. */
	before?: ApprovedPermission;
	/**
	 * - `kept`: as approved;
	 * - `new`: nothing approved before (a first approval);
	 * - `changed`: the frontmatter now says otherwise; the approval confirms it;
	 * - `needs-answer`: an `ask` nobody answered for unattended runs;
	 * - `answer-dropped`: answered before, now set by the frontmatter.
	 */
	status: "kept" | "new" | "changed" | "needs-answer" | "answer-dropped";
	/** What unattended runs get once approved; undefined while it needs an answer. */
	result?: ApprovedPermission;
}

/** What approving the note as it is now would change, permission by permission. */
export interface ApprovalReview {
	permissions: PermissionReview[];
	/** The `ask`s that need an answer before the note can be approved. */
	needsAnswer: ApprovalPermissionKey[];
	/** Whether any permission is other than kept: a dialog shows them, else one action approves. */
	changed: boolean;
}

/**
 * Compares the note's permissions with what `before` holds (#299): approving
 * again, or handing over, asks only about what changed. An approval from
 * 0.4.x holds no permissions: they were the frontmatter's, as long as the
 * note is the one approved.
 */
export function reviewApproval(before: NoteApproval | undefined, note: ScheduledNoteNow): ApprovalReview {
	const legacy = before !== undefined && before.permissions === undefined;
	const permissions = APPROVAL_PERMISSION_KEYS.map((key): PermissionReview => {
		const now = note.permissions[key];
		const held: ApprovedPermission | undefined = before?.permissions?.[key];
		const prior: ApprovedPermission | undefined =
			held ?? (legacy && before?.hash === note.hash && now !== "ask" ? { value: now, source: "frontmatter" } : undefined);
		const base = { key, now, ...(prior !== undefined ? { before: prior } : {}) };
		if (now === "ask") {
			if (prior?.source === "answer") return { ...base, status: "kept", result: prior };
			return { ...base, status: "needs-answer" };
		}
		const result: ApprovedPermission = { value: now, source: "frontmatter" };
		if (prior === undefined) return { ...base, status: legacy || before === undefined ? "new" : "changed", result };
		if (prior.source === "answer") return { ...base, status: "answer-dropped", result };
		return { ...base, status: prior.value === now ? "kept" : "changed", result };
	});
	return {
		permissions,
		needsAnswer: permissions.filter((p) => p.status === "needs-answer").map((p) => p.key),
		changed: permissions.some((p) => p.status !== "kept"),
	};
}

/** An answer given where the frontmatter decides, or a permission left unanswered. */
export class ApprovalAnswerError extends Error {
	constructor(
		message: string,
		readonly unanswered: ApprovalPermissionKey[]
	) {
		super(message);
		this.name = "ApprovalAnswerError";
	}
}

/**
 * The permissions an approval holds, from a review and the answers given for
 * its `ask`s. An answer may replace one kept from before; an answer for a
 * permission the frontmatter sets is refused, and so is an `ask` left
 * unanswered, naming them.
 */
export function approvedPermissions(
	review: ApprovalReview,
	answers: Partial<Record<ApprovalPermissionKey, "allow" | "deny">> = {}
): ApprovedPermissions {
	const fixed = review.permissions.filter((p) => p.now !== "ask" && answers[p.key] !== undefined).map((p) => p.key);
	if (fixed.length > 0) {
		throw new ApprovalAnswerError(`${fixed.join(", ")} ${fixed.length === 1 ? "is" : "are"} set by the frontmatter, not asked`, []);
	}
	const unanswered = review.needsAnswer.filter((key) => answers[key] === undefined);
	if (unanswered.length > 0) {
		throw new ApprovalAnswerError(`${unanswered.join(", ")} ${unanswered.length === 1 ? "needs" : "need"} an answer`, unanswered);
	}
	const held = {} as ApprovedPermissions;
	for (const p of review.permissions) {
		const answer = answers[p.key];
		held[p.key] = answer !== undefined ? { value: answer, source: "answer" } : (p.result as ApprovedPermission);
	}
	return held;
}

/**
 * The permissions an unattended run of the note gets from its approval, or
 * undefined when the approval does not cover them as the note is now: a
 * permission whose frontmatter value changed, an `ask` not answered at
 * approval. An approval from 0.4.x covers a note with no `ask`.
 */
export function coveredPermissions(approval: NoteApproval, note: ScheduledNoteNow): ApprovedPermissions | undefined {
	const covered = {} as ApprovedPermissions;
	for (const key of APPROVAL_PERMISSION_KEYS) {
		const now = note.permissions[key];
		const held = approval.permissions?.[key];
		if (held === undefined) {
			if (approval.permissions !== undefined || now === "ask") return undefined;
			covered[key] = { value: now, source: "frontmatter" };
		} else if (now === "ask" ? held.source !== "answer" : held.source !== "frontmatter" || held.value !== now) {
			return undefined;
		} else {
			covered[key] = held;
		}
	}
	return covered;
}

/** Whether `approval` covers the note as it is now, under `binding`. */
export function approvalCovers(approval: NoteApproval, note: ScheduledNoteNow, binding: ApprovalBinding): boolean {
	const bound = binding === "content" ? approval.hash === note.hash : approval.schedule === note.schedule;
	return bound && coveredPermissions(approval, note) !== undefined;
}

export type NoteScheduleState =
	/** This runner owns it, and the approval applies to the note as it is: it runs. */
	| { state: "approved"; approval: NoteApproval }
	/** Nobody approved it on this computer. */
	| { state: "not-approved" }
	/** The other runner owns it. */
	| { state: "delegated"; approval: NoteApproval }
	/** This runner owns it, but the note changed since, under its binding: it runs once approved again. */
	| { state: "changed"; approval: NoteApproval; review: ApprovalReview }
	/** The plugin owns it, and "Run scheduled workflows" is off. */
	| { state: "off"; approval: NoteApproval };

/**
 * Whether `runner` runs `note` on schedule. The approval binds what the
 * owner's binding names (the agent: the content; the plugin: the content or
 * only the schedule) and always the permissions; the plugin runs its notes
 * while "Run scheduled workflows" is on.
 */
export function noteScheduleState(runner: ScheduleOwner, schedules: VaultSchedules, note: ScheduledNoteNow): NoteScheduleState {
	const approval = approvalOf(schedules, note.path);
	if (approval === undefined) return { state: "not-approved" };
	if (approval.owner !== runner) return { state: "delegated", approval };
	if (!approvalCovers(approval, note, bindingOf(schedules, runner))) {
		return { state: "changed", approval, review: reviewApproval(approval, note) };
	}
	if (runner === "obsidian" && !schedules.obsidianScheduling) return { state: "off", approval };
	return { state: "approved", approval };
}

/**
 * Turns Obsidian's "Run scheduled workflows" on or off, noting when it was
 * turned on: the notes it runs are scheduled from then (#308).
 */
export function setObsidianScheduling(schedules: VaultSchedules, on: boolean, now: Date = new Date()): void {
	if (on && !schedules.obsidianScheduling) schedules.obsidianSchedulingSince = now.toISOString();
	if (!on) delete schedules.obsidianSchedulingSince;
	schedules.obsidianScheduling = on;
}

/**
 * Since when the note at `path` is scheduled as its approval says: since it
 * was approved, and for a note Obsidian runs, since "Run scheduled
 * workflows" was turned on, whichever is later. Undefined while it is not
 * scheduled: no approval, or Obsidian's and the switch off. A note the agent
 * runs is scheduled while the agent is stopped (#308). Undefined too for an
 * approval copied from 0.4.x: the runner's arming time bounds its look.
 */
export function scheduledSince(schedules: VaultSchedules, path: string): Date | undefined {
	const approval = approvalOf(schedules, path);
	// Copied from 0.4.x, which kept no record of what ran: its approval time
	// says nothing about which runs were missed (#328).
	if (approval === undefined || approval.permissions === undefined) return undefined;
	const approved = new Date(approval.approvedAt);
	if (Number.isNaN(approved.getTime())) return undefined;
	if (approval.owner === "agent") return approved;
	if (!schedules.obsidianScheduling) return undefined;
	const on = schedules.obsidianSchedulingSince === undefined ? approved : new Date(schedules.obsidianSchedulingSince);
	return on > approved ? on : approved;
}

/**
 * Why a catch-up of a note with `approval` may not run, or undefined. A note
 * Obsidian runs is not scheduled while "Run scheduled workflows" is off, so
 * none of its runs is missed for it to catch up (#307). A note the agent runs
 * stays scheduled while the agent is stopped.
 */
export function catchUpRefusal(schedules: VaultSchedules, approval: NoteApproval): string | undefined {
	if (approval.owner === "obsidian" && !schedules.obsidianScheduling) {
		return "Obsidian runs it on schedule, and Run scheduled workflows is off on this computer; turn it on first, or dismiss its missed runs";
	}
	return undefined;
}

/** The note's approval, if it has one. */
export function approvalOf(schedules: VaultSchedules, path: string): NoteApproval | undefined {
	return Object.prototype.hasOwnProperty.call(schedules.notes, path) ? schedules.notes[path] : undefined;
}

/**
 * Approves `note` to run on schedule in `owner` with `permissions`, replacing
 * any approval it had: a handover is an approval too. `permissions` come from
 * `approvedPermissions` over a review of the note as it is.
 */
export function approveNote(
	schedules: VaultSchedules,
	note: ScheduledNoteNow,
	owner: ScheduleOwner,
	permissions: ApprovedPermissions,
	now: Date = new Date()
): void {
	schedules.notes[note.path] = { owner, schedule: note.schedule, hash: note.hash, approvedAt: now.toISOString(), permissions };
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
