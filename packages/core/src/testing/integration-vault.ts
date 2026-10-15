/**
 * Shared setup for the container integration tests (`*.integration.test.ts`).
 *
 * Not part of the published bundle: tsup builds only the entries in
 * tsup.config.ts, and nothing outside the integration tests imports this.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { execContainer } from "../runtime";
import { resolveInVaultRoot } from "../vault/confine";
import type { PlatformAdapter, RuntimeEngine } from "../types";

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
		resolveInVault: (path: string) => resolveInVaultRoot(root, path),
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

/**
 * Wait until a container sees `path` with exactly `expected` in it.
 *
 * On colima (QEMU, sshfs mount) a container can read a file the host has just
 * rewritten with its old size: the new text cut off where the old text ended
 * (#83). Seen in the smart-inbox test after a host edit: stale for 0.3-0.9 s
 * of polling, and a fixed 1.5 s delay before the run was not enough.
 *
 * `vault.write` no longer persists such a copy: the host refuses a write whose
 * base is not the note on disk. A cell that only reads still sees it, so a test
 * that asserts what a cell read after a host edit waits here rather than
 * guessing a delay.
 */
export async function waitForContainerView(
	root: string,
	path: string,
	expected: string,
	timeoutMs = 20_000
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	let seen = "";
	while (Date.now() < deadline) {
		const result = await execContainer(IT_ENGINE as RuntimeEngine, {
			image: "alpine:3.19",
			command: ["cat", `/workspace/${path}`],
			mounts: [{ source: root, target: "/workspace", readonly: true }],
		});
		seen = result.stdout;
		if (seen === expected) return;
	}
	throw new Error(
		`a container still sees a different ${path} after ${timeoutMs}ms: ${JSON.stringify(seen)}`
	);
}
