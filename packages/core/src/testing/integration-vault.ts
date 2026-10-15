/**
 * Shared setup for the container integration tests (`*.integration.test.ts`).
 *
 * Not part of the published bundle: tsup builds only the entries in
 * tsup.config.ts, and nothing outside the integration tests imports this.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { PlatformAdapter } from "../types";

/** The engine the integration tests run on. colima unless overridden. */
export const IT_ENGINE = process.env.VAULTORE_IT_ENGINE ?? "colima";

/**
 * A temporary vault directory under `$HOME/.cache`: colima mounts only the
 * home directory into its VM, so a vault under /tmp would appear empty to the
 * container.
 */
export function makeIntegrationVaultRoot(): string {
	const base = join(homedir(), ".cache");
	mkdirSync(base, { recursive: true });
	return mkdtempSync(join(base, "vaultore-it-"));
}

export interface FilesystemPlatformOptions {
	/** Settings beyond the engine, which is always IT_ENGINE. */
	settings?: Record<string, unknown>;
	secrets?: Record<string, string>;
}

/** A PlatformAdapter over a plain directory, as the CLI would provide. */
export function filesystemPlatform(
	root: string,
	options: FilesystemPlatformOptions = {}
): PlatformAdapter {
	const settings = new Map<string, unknown>([
		["vaultore.runtimeEngine", IT_ENGINE],
		...Object.entries(options.settings ?? {}),
	]);
	const secrets = new Map<string, string>(Object.entries(options.secrets ?? {}));
	const abs = (path: string) => join(root, path);
	return {
		platform: "cli",
		readFile: async (path: string) => readFileSync(abs(path), "utf8"),
		writeFile: async (path: string, content: string) => {
			mkdirSync(dirname(abs(path)), { recursive: true });
			writeFileSync(abs(path), content);
		},
		exists: async (path: string) => existsSync(abs(path)),
		mkdirp: async (path: string) => {
			mkdirSync(abs(path), { recursive: true });
		},
		listFiles: async () => [],
		getVaultRoot: async () => root,
		getSetting: <T>(key: string) => settings.get(key) as T | undefined,
		setSetting: async (key: string, value: unknown) => {
			settings.set(key, value);
		},
		getSecret: async (key: string) => secrets.get(key),
		setSecret: async (key: string, value: string) => {
			secrets.set(key, value);
		},
		deleteSecret: async (key: string) => {
			secrets.delete(key);
		},
		log: () => undefined,
	};
}
