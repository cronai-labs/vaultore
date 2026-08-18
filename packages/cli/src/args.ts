/**
 * Argument parsing and vault-path resolution for the `vaultore` command.
 *
 * Kept separate from cli.ts so it can be unit tested — cli.ts runs main() on
 * import and cannot be loaded from a test.
 */

import { isAbsolute, relative, resolve, sep } from "node:path";

export interface ParsedArgs {
	positional: string[];
	flags: Record<string, string | boolean>;
}

/**
 * Flags that consume the following argument as their value. Every other flag is
 * a boolean — without this list `--yes workflow.md` swallows the workflow path.
 */
const VALUE_FLAGS = new Set(["vault", "cell", "rescan", "out"]);

export function parseArgs(argv: string[]): ParsedArgs {
	const positional: string[] = [];
	const flags: Record<string, string | boolean> = {};

	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === undefined) continue;

		if (arg === "--") {
			positional.push(...argv.slice(i + 1).filter((a): a is string => a !== undefined));
			break;
		}

		if (!arg.startsWith("--")) {
			positional.push(arg);
			continue;
		}

		const body = arg.slice(2);
		const eq = body.indexOf("=");
		if (eq !== -1) {
			flags[body.slice(0, eq)] = body.slice(eq + 1);
			continue;
		}

		if (!VALUE_FLAGS.has(body)) {
			flags[body] = true;
			continue;
		}

		const next = argv[i + 1];
		if (next === undefined || next.startsWith("--")) {
			throw new Error(`--${body} requires a value`);
		}
		flags[body] = next;
		i += 1;
	}

	return { positional, flags };
}

export function hasExplicitVault(flags: Record<string, string | boolean>): boolean {
	return typeof flags["vault"] === "string";
}

export function vaultRootFrom(flags: Record<string, string | boolean>): string {
	const flag = flags["vault"];
	return resolve(typeof flag === "string" ? flag : process.cwd());
}

/**
 * Resolve a workflow argument to a vault-relative path.
 *
 * A relative argument is resolved against the vault root when --vault was given
 * explicitly, and against the current directory otherwise. Without that, the
 * documented `vaultore run Workflows/digest.md --vault ~/notes` form fails from
 * any directory other than the vault root itself.
 */
export function toVaultRelative(
	vaultRoot: string,
	workflowArg: string,
	options: { vaultExplicit?: boolean } = {}
): string {
	const base = options.vaultExplicit === true ? vaultRoot : process.cwd();
	const abs = isAbsolute(workflowArg) ? workflowArg : resolve(base, workflowArg);
	const rel = relative(vaultRoot, abs);

	if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) {
		throw new Error(`Workflow ${workflowArg} resolves to ${abs}, which is outside the vault ${vaultRoot}`);
	}

	return rel.split(sep).join("/");
}
