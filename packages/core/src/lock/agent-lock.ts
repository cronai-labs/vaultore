import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { LockHeldError, acquireLock, describeHolder, holderGoneBecause, readLockHolder } from "./index";
import type { LockHolder, LockOptions } from "./index";
import { userStateDirectory } from "./run-lock";

/**
 * The lock `vaultore agent` holds on a vault while it runs (#301): one agent
 * per vault on this computer, and a trace the plugin reads to say whether the
 * notes delegated to the agent run. Named after the vault's real path.
 */

/** `~/.config/vaultore/agents`, `%APPDATA%\vaultore\agents` on Windows. */
export function agentLockDirectory(
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
	accountHome?: () => string
): string {
	return userStateDirectory("agents", "agent locks", platform, env, ...(accountHome ? [accountHome] : []));
}

/** The lock for the vault whose real path is `vaultKey` (`vaultKeyFor`). */
export function agentLockPath(vaultKey: string, directory: string = agentLockDirectory()): string {
	return join(directory, `${createHash("sha256").update(vaultKey.normalize("NFC")).digest("hex")}.lock`);
}

/** Another agent runs the vault. The message names it. */
export class AgentRunningError extends Error {
	constructor(
		readonly holder: LockHolder | undefined,
		message: string
	) {
		super(message);
		this.name = "AgentRunningError";
	}
}

export interface AgentLockOptions extends Pick<LockOptions, "isAlive" | "host" | "bootTime" | "onStale"> {
	/** The vault's real path (`vaultKeyFor`). */
	vaultKey: string;
	/** Where the locks are. Default: `agentLockDirectory()`. Tests pass their own. */
	directory?: string;
}

/**
 * Takes the vault's agent lock, for as long as the agent runs. Resolves to its
 * release. Rejects with AgentRunningError when another agent holds it; a lock
 * left by an agent that is gone is taken over and reported.
 */
export async function acquireAgentLock(options: AgentLockOptions): Promise<() => Promise<void>> {
	const { vaultKey, directory = agentLockDirectory(), ...lockOptions } = options;
	await fs.mkdir(directory, { recursive: true, mode: 0o700 });
	try {
		return await acquireLock(agentLockPath(vaultKey, directory), { ...lockOptions, by: "vaultore agent" });
	} catch (err) {
		if (!(err instanceof LockHeldError)) throw err;
		const holder = err.holder;
		throw new AgentRunningError(
			holder,
			holder
				? `Another vaultore agent runs the vault ${vaultKey}: ${describeHolder(holder)} on ${holder.host}, since ${holder.since}. Stop it first`
				: `${err.message}`
		);
	}
}

export type AgentStatus =
	/** An agent runs the vault on this computer. */
	| { state: "running"; holder: LockHolder }
	/** No agent runs it. */
	| { state: "stopped" }
	/** Held from another computer sharing this home folder: whether it runs cannot be told here. */
	| { state: "unknown"; holder: LockHolder };

/** Whether an agent runs the vault whose real path is `vaultKey`, read without taking anything. */
export async function agentStatus(
	options: Pick<AgentLockOptions, "vaultKey" | "directory" | "isAlive" | "host" | "bootTime">
): Promise<AgentStatus> {
	const { vaultKey, directory = agentLockDirectory(), ...check } = options;
	const holder = await readLockHolder(agentLockPath(vaultKey, directory));
	if (!holder) return { state: "stopped" };
	if (holder.host !== (check.host ?? hostname())) return { state: "unknown", holder };
	// holderGoneBecause judges other processes; an agent in this one runs.
	if (holder.pid === process.pid) return { state: "running", holder };
	return holderGoneBecause(holder, check) === undefined ? { state: "running", holder } : { state: "stopped" };
}
