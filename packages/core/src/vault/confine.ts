/**
 * @vaultore/core - keeping host file access inside the vault
 *
 * A cell with vaultWrite can create symbolic links through its mount. Inside
 * the container a link resolves inside the container; on the host the same
 * link resolves on the host, so a link to `~/.ssh` planted by a cell would let
 * a host-side read or write reach it. Platforms implement
 * `PlatformAdapter.resolveInVault` with this function on desktop.
 */

import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

function codeOf(err: unknown): string | undefined {
	return err && typeof err === "object" && "code" in err
		? String(err.code)
		: undefined;
}

function inside(root: string, target: string): boolean {
	const rel = relative(root, target);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function toVaultPath(root: string, target: string): string {
	return relative(root, target).split(sep).join("/");
}

/**
 * The vault-relative path `path` really leads to, with `/` separators, or an
 * error. Rules:
 *
 * - No absolute path and no `..` segment.
 * - A symbolic link as the last component is refused, wherever it points: a
 *   write would replace or follow it, and neither is what the caller asked.
 * - A directory symbolic link on the way is followed only if its real target
 *   lies inside the real vault root; the result is then the real path.
 * - Components that do not exist yet are kept as given, below the deepest
 *   one that exists.
 */
export async function resolveInVaultRoot(vaultRoot: string, path: string): Promise<string> {
	if (/^[\\/]/.test(path) || /^[A-Za-z]:/.test(path)) {
		throw new Error(`Path outside the vault refused: ${path}`);
	}
	const segments = path.split(/[\\/]/).filter((segment) => segment !== "" && segment !== ".");
	if (segments.includes("..")) {
		throw new Error(`Path outside the vault refused: ${path}`);
	}

	const root = await realpath(vaultRoot);
	let current = root;
	for (let i = 0; i < segments.length; i += 1) {
		const next = join(current, segments[i] ?? "");
		let stat;
		try {
			stat = await lstat(next);
		} catch (err) {
			if (codeOf(err) !== "ENOENT") throw err;
			return toVaultPath(root, join(next, ...segments.slice(i + 1)));
		}
		if (!stat.isSymbolicLink()) {
			current = next;
			continue;
		}

		const link = segments.slice(0, i + 1).join("/");
		if (i === segments.length - 1) {
			throw new Error(`${path} is a symbolic link; VaultOre does not read or write through one`);
		}
		let target: string;
		try {
			target = await realpath(next);
		} catch {
			throw new Error(`${path} goes through ${link}, a symbolic link to nothing; refused`);
		}
		if (!inside(root, target)) {
			throw new Error(`${path} leads outside the vault through the symbolic link ${link}; refused`);
		}
		current = target;
	}
	return toVaultPath(root, current);
}
