import { promises as fs } from "node:fs";
import { join } from "node:path";
import { errorMessage } from "../errors";
import { isRecord } from "./vault-state-store";

/**
 * Where each runner keeps its permission answers for a vault (#299). Both
 * runners on one computer share the device the answers are bound to (#284),
 * so each reads the other's file as well as its own; each writes only its own.
 */

/** The plugin's id, and the name of its folder under the vault's config folder. */
export const PLUGIN_ID = "vaultore";

/** The plugin's settings, `deviceDecisions` among them. */
export function pluginSettingsPath(vaultRoot: string, configDir: string): string {
	return join(vaultRoot, configDir, "plugins", PLUGIN_ID, "data.json");
}

/** The CLI's settings for a vault, `deviceDecisions` among them. */
export function cliConfigPath(vaultRoot: string): string {
	return join(vaultRoot, ".vaultore", "config.json");
}

/** The answers another runner keeps, as found in its file. */
export interface RunnerDecisions {
	/** The file they were read from, for messages. */
	file: string;
	/** Its `deviceDecisions`, unchecked: the file is in the vault, anyone who can write it can change it. */
	decisions: unknown;
}

/**
 * Reads the answers kept in `file`, at the moment of asking, so that a runner
 * that is already open sees what the other stored since. Undefined when the
 * file does not exist. A file that cannot be read or is not JSON is an error
 * naming it; the caller treats it as no answers.
 */
export async function readRunnerDecisions(file: string): Promise<RunnerDecisions | undefined> {
	let text: string;
	try {
		text = await fs.readFile(file, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw new Error(`Cannot read the permission answers in ${file}: ${errorMessage(err)}`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (err) {
		throw new Error(`Cannot read the permission answers in ${file}: it is not JSON (${errorMessage(err)})`);
	}
	return { file, decisions: isRecord(parsed) ? parsed["deviceDecisions"] : undefined };
}
