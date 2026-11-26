import { createHmac, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { userStateDirectory } from "../lock/run-lock";
import { errorMessage } from "../errors";
import { readMachineSettings } from "./machine-settings";
import { isRecord } from "./vault-state-store";

/**
 * What ties a stored permission decision to the account and computer it was
 * made on (#284): `device.json` in VaultOre's folder for this user, outside
 * every vault, made once and shared by both runners. Random, not derived from
 * the hardware: nothing about the machine is in it, and it cannot be made
 * again elsewhere.
 *
 * - `id` is public: a decision names the device it was made on with it.
 * - `key` is secret: a decision carries a MAC made with it, so a decision
 *   written by anyone who can only write the vault does not verify, and
 *   neither does one copied to another note, vault or device.
 */
export interface DecisionDevice {
	/** The public id of this account on this computer. */
	id: string;
	/** HMAC-SHA256 of `text` with this device's secret key, as hex. */
	sign(text: string): string;
	/**
	 * Whether decisions made on other devices, or stored before decisions
	 * carried a device, apply here too: `decisionsFromOtherDevices` in
	 * `settings.json`. Off unless set.
	 */
	acceptOtherDevices: boolean;
}

export interface DecisionDeviceOptions {
	/** The device file. Default: `deviceFilePath()`. Tests pass their own. */
	devicePath?: string;
	/** The shared settings. Default: `machineSettingsPath()`. */
	settingsPath?: string;
}

const FORMAT = "vaultore.device";
const VERSION = 1;

/** Where this account's device file lives on this computer; found as the run locks are. */
export function deviceFilePath(
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
	accountHome?: () => string
): string {
	return userStateDirectory("device.json", "device file", platform, env, ...(accountHome ? [accountHome] : []));
}

/**
 * This account's device on this computer, made on first use. Two runners
 * that make it at once agree on one: it is put in place only where none is
 * yet, and whoever comes second reads the first one's. A file that cannot be
 * read or is not a device file is an error naming it, never replaced: a new
 * one would silently withdraw every decision made here.
 */
export async function readDecisionDevice(options: DecisionDeviceOptions = {}): Promise<DecisionDevice> {
	const path = options.devicePath ?? deviceFilePath();
	const { id, key } = (await readDevice(path)) ?? (await createDevice(path));
	const settings = await readMachineSettings(options.settingsPath !== undefined ? { path: options.settingsPath } : {});
	const secret = Buffer.from(key, "hex");
	return {
		id,
		sign: (text) => createHmac("sha256", secret).update(text, "utf8").digest("hex"),
		acceptOtherDevices: settings.decisionsFromOtherDevices === true,
	};
}

async function readDevice(path: string): Promise<{ id: string; key: string } | undefined> {
	let text: string;
	try {
		text = await fs.readFile(path, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw unusable(path, errorMessage(err));
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (err) {
		throw unusable(path, `it is not JSON (${errorMessage(err)})`);
	}
	if (!isRecord(parsed) || parsed["format"] !== FORMAT) throw unusable(path, "it is not a VaultOre device file");
	if (parsed["version"] !== VERSION) {
		throw unusable(
			path,
			`it has version ${JSON.stringify(parsed["version"])}, and this VaultOre reads version ${VERSION}`
		);
	}
	const id = parsed["id"];
	const key = parsed["key"];
	if (typeof id !== "string" || !/^[0-9a-f]{32}$/.test(id)) throw unusable(path, "its id is not 32 hex digits");
	if (typeof key !== "string" || !/^[0-9a-f]{64}$/.test(key)) throw unusable(path, "its key is not 64 hex digits");
	return { id, key };
}

async function createDevice(path: string): Promise<{ id: string; key: string }> {
	await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const device = {
		format: FORMAT,
		version: VERSION,
		id: randomBytes(16).toString("hex"),
		key: randomBytes(32).toString("hex"),
		createdAt: new Date().toISOString(),
	};
	const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
	try {
		await fs.writeFile(temporary, JSON.stringify(device, null, 2) + "\n", { mode: 0o600, flag: "wx" });
		// A hard link is put in place only where nothing is yet, whole: a
		// reader sees no file or the complete one.
		await fs.link(temporary, path);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
	} finally {
		await fs.rm(temporary, { force: true });
	}
	const placed = await readDevice(path);
	if (!placed) throw unusable(path, "it was removed while it was made");
	return placed;
}

function unusable(path: string, reason: string): Error {
	return new Error(
		`Cannot use VaultOre's device file ${path}: ${reason}. It was left as it is; repair or remove it. ` +
			`A new one is made where none is, and every permission decision made here is then asked again`
	);
}
