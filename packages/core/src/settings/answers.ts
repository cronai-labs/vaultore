import { userStateDirectory } from "../lock/run-lock";
import { VaultStateStore, isRecord } from "./vault-state-store";
import type { VaultStateStoreOps } from "./vault-state-store";

/**
 * The answers a person gave to a note's `ask` permissions, for runs started
 * by hand (#299): one file for the account on this computer, beside the
 * schedule approvals, shared by the plugin and the CLI. Outside every vault:
 * what may grant a permission on this computer must not be something a
 * synced file, or anyone who can write the vault, can change. Each runner
 * reads it when a run asks, and writes the answers given, under its lock.
 *
 * A record holds only what it means wherever it is read: the note, the
 * content it was given for, each answer, and when. Nothing in it is bound to
 * this machine, so that answers can later be signed and carried to another
 * computer that trusts this one, by any transport (#305).
 */

/** The answers kept for one note, for one content of it. */
export interface StoredAnswers {
	/** `grantHash` of the note the answers were given for: another content asks again. */
	workflowHash: string;
	/** When the first of them was given, ISO 8601. */
	grantedAt: string;
	network?: "allow" | "deny";
	buildNetwork?: "allow" | "deny";
	vaultRead?: "allow" | "deny";
	vaultWrite?: "allow" | "deny";
}

/** One vault's answers on this computer. */
export interface VaultAnswers {
	/** Vault-relative note path to its answers. */
	notes: Record<string, StoredAnswers>;
}

export const ANSWERS_FILE = "answers.json";

const ANSWER_KEYS = ["network", "buildNetwork", "vaultRead", "vaultWrite"] as const;

/** `~/.config/vaultore/answers.json`, `%APPDATA%\vaultore\answers.json` on Windows. */
export function answersPath(
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
	accountHome?: () => string
): string {
	return userStateDirectory(ANSWERS_FILE, "permission answers", platform, env, ...(accountHome ? [accountHome] : []));
}

function invalidAnswers(value: unknown): string | undefined {
	if (!isRecord(value)) return "is not a record";
	if (typeof value["workflowHash"] !== "string" || typeof value["grantedAt"] !== "string") return "is incomplete";
	for (const key of ANSWER_KEYS) {
		const answer = value[key];
		if (answer !== undefined && answer !== "allow" && answer !== "deny") return `holds ${key} ${JSON.stringify(answer)}, which is no answer`;
	}
	return undefined;
}

export interface AnswersStoreOptions extends VaultStateStoreOps {
	/** The file. Default: `answersPath()`. Tests pass their own. */
	path?: string;
}

/** The store of every vault's permission answers on this computer, in one file. */
export function answersStore(options: AnswersStoreOptions = {}): VaultStateStore<VaultAnswers> {
	const { path, ...ops } = options;
	return new VaultStateStore<VaultAnswers>(
		{
			file: path ?? answersPath(),
			format: "vaultore.permission-answers",
			version: 1,
			what: "permission answers file",
			invalid: (entry, vault) => {
				if (!isRecord(entry) || !isRecord(entry["notes"])) return `the entry for vault ${vault} is incomplete`;
				for (const [note, answers] of Object.entries(entry["notes"])) {
					const why = invalidAnswers(answers);
					if (why !== undefined) return `the answers for ${note} in vault ${vault} ${why}`;
				}
				return undefined;
			},
			// Without a prototype: a note path such as "__proto__" is an entry like any other.
			copy: (entry) => ({ notes: Object.assign(Object.create(null) as Record<string, StoredAnswers>, entry?.notes) }),
			isEmpty: (entry) => Object.keys(entry.notes).length === 0,
		},
		ops
	);
}
