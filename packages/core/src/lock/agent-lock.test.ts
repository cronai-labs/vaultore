import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentRunningError, acquireAgentLock, agentLockDirectory, agentLockPath, agentStatus } from "./agent-lock";

/** One agent per vault on a computer, and a trace the plugin reads (#301). */

let directory: string;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "vaultore-agent-lock-"));
});

afterEach(() => {
	rmSync(directory, { recursive: true, force: true });
});

describe("the agent lock", () => {
	it("lives beside the run locks, one per vault", () => {
		expect(agentLockDirectory("darwin", {}, () => "/Users/me")).toBe("/Users/me/.config/vaultore/agents");
		expect(agentLockPath("/vaults/a", directory)).not.toBe(agentLockPath("/vaults/b", directory));
	});

	it("says no agent runs a vault nobody locked", async () => {
		expect(await agentStatus({ vaultKey: "/vaults/a", directory })).toEqual({ state: "stopped" });
	});

	it("says the agent runs while it holds the lock, and no longer once released", async () => {
		const release = await acquireAgentLock({ vaultKey: "/vaults/a", directory });
		const status = await agentStatus({ vaultKey: "/vaults/a", directory });
		expect(status).toMatchObject({ state: "running", holder: { pid: process.pid, by: "vaultore agent" } });

		await release();
		expect(await agentStatus({ vaultKey: "/vaults/a", directory })).toEqual({ state: "stopped" });
	});

	it("refuses a second agent on the same vault, naming the first, and lets one run another vault", async () => {
		const release = await acquireAgentLock({ vaultKey: "/vaults/a", directory, isAlive: () => true });
		try {
			const second = acquireAgentLock({ vaultKey: "/vaults/a", directory, isAlive: () => true, bootTime: 0 });
			await expect(second).rejects.toThrow(AgentRunningError);
			await expect(acquireAgentLock({ vaultKey: "/vaults/a", directory, isAlive: () => true, bootTime: 0 })).rejects.toThrow(
				`Another vaultore agent runs the vault /vaults/a: process ${process.pid} (vaultore agent)`
			);
			const other = await acquireAgentLock({ vaultKey: "/vaults/b", directory });
			await other();
		} finally {
			await release();
		}
	});

	it("says no agent runs when the one holding the lock is gone", async () => {
		const lock = agentLockPath("/vaults/a", directory);
		mkdirSync(lock);
		writeFileSync(join(lock, "1.json"), JSON.stringify({ pid: 999999, host: hostname(), since: new Date().toISOString(), by: "vaultore agent" }));

		expect(await agentStatus({ vaultKey: "/vaults/a", directory, isAlive: () => false })).toEqual({ state: "stopped" });
		expect(await agentStatus({ vaultKey: "/vaults/a", directory, isAlive: () => true, bootTime: 0 })).toMatchObject({ state: "running" });
	});

	it("cannot tell for a lock taken on another computer sharing the folder", async () => {
		const release = await acquireAgentLock({ vaultKey: "/vaults/a", directory, host: "elsewhere" });
		try {
			expect(await agentStatus({ vaultKey: "/vaults/a", directory, host: "here" })).toMatchObject({ state: "unknown" });
		} finally {
			await release();
		}
	});
});
