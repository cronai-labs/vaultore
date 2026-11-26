import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { acquireLockWaiting } from "../lock";
import type { LockWait } from "../lock";
import { userStateDirectory } from "../lock/run-lock";
import { errorMessage } from "../errors";

/**
 * Settings of this machine that both runners must share, because the record
 * they share depends on them: `~/.config/vaultore/settings.json`, beside the
 * run locks and the schedule record (specs/schedule-record-spec.md). Outside
 * the vault, so sync cannot change them, and one per machine, as the record
 * is. A setting that each runner may choose for itself stays with that runner.
 */
export interface MachineSettings {
	/**
	 * How many minutes late a scheduled run may start and still run, 2 to 60.
	 * Absent: 2. Later, the occurrence is a missed run (#269).
	 */
	lateAfterMinutes?: number;
}

export const MIN_LATE_AFTER_MINUTES = 2;
export const MAX_LATE_AFTER_MINUTES = 60;

export interface MachineSettingsOptions {
	/** The file. Default: `machineSettingsPath()`. Tests pass their own. */
	path?: string;
	/** How long a change waits while another process changes the file. */
	wait?: LockWait;
}

/** Where this machine's shared settings live; found as the run locks are. */
export function machineSettingsPath(
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
	accountHome?: () => string
): string {
	return userStateDirectory("settings.json", "settings", platform, env, ...(accountHome ? [accountHome] : []));
}

/** Whether `minutes` is a late threshold a runner accepts. */
export function isLateAfterMinutes(minutes: unknown): minutes is number {
	return (
		typeof minutes === "number" &&
		Number.isInteger(minutes) &&
		minutes >= MIN_LATE_AFTER_MINUTES &&
		minutes <= MAX_LATE_AFTER_MINUTES
	);
}

async function readObject(path: string): Promise<Record<string, unknown>> {
	let text: string;
	try {
		text = await fs.readFile(path, "utf8");
	} catch (err) {
		if (typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT") return {};
		throw err;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (err) {
		throw new Error(`${path} is not valid JSON (${errorMessage(err)}); fix or remove it`);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`${path} must hold a JSON object; fix or remove it`);
	}
	return parsed as Record<string, unknown>;
}

/**
 * This machine's shared settings. A missing file is the defaults; a file that
 * cannot be read, or holds a value out of range, is an error naming it, not a
 * silent default: a runner that guessed could disagree with the other.
 */
export async function readMachineSettings(options: MachineSettingsOptions = {}): Promise<MachineSettings> {
	const path = options.path ?? machineSettingsPath();
	const raw = await readObject(path);
	const settings: MachineSettings = {};
	if (raw["lateAfterMinutes"] !== undefined) {
		if (!isLateAfterMinutes(raw["lateAfterMinutes"])) {
			throw new Error(
				`${path}: lateAfterMinutes must be a whole number of minutes from ${MIN_LATE_AFTER_MINUTES} ` +
					`to ${MAX_LATE_AFTER_MINUTES}, got ${JSON.stringify(raw["lateAfterMinutes"])}`
			);
		}
		settings.lateAfterMinutes = raw["lateAfterMinutes"];
	}
	return settings;
}

/**
 * Changes this machine's shared settings: a value sets a key, `undefined`
 * removes it (back to its default). Keys this version does not know are kept.
 * Written under a name of its own and renamed into place, so a reader sees the
 * old file or the new one, never half of one.
 */
export async function writeMachineSettings(
	changes: { [K in keyof MachineSettings]?: MachineSettings[K] | undefined },
	options: MachineSettingsOptions = {}
): Promise<MachineSettings> {
	const path = options.path ?? machineSettingsPath();
	if (changes.lateAfterMinutes !== undefined && !isLateAfterMinutes(changes.lateAfterMinutes)) {
		throw new Error(
			`Late after must be a whole number of minutes from ${MIN_LATE_AFTER_MINUTES} to ${MAX_LATE_AFTER_MINUTES}, ` +
				`got ${String(changes.lateAfterMinutes)}`
		);
	}
	await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
	// Read, change and write under a lock: Obsidian and a vaultore command
	// changing different settings at the same moment keep both changes.
	const release = await acquireLockWaiting(`${path}.lock`, { wait: options.wait });
	try {
		const raw = await readObject(path);
		for (const [key, value] of Object.entries(changes)) {
			if (value === undefined) delete raw[key];
			else raw[key] = value;
		}
		const temp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
		try {
			await fs.writeFile(temp, JSON.stringify(raw, null, 2) + "\n", { mode: 0o600 });
			await fs.rename(temp, path);
		} catch (err) {
			await fs.rm(temp, { force: true });
			throw err;
		}
	} finally {
		await release();
	}
	return readMachineSettings({ path });
}
