import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { execContainer } from "./index";
import { nodeTimers } from "../testing/timers";
import { IT_ENGINE } from "../testing/integration-vault";
import type { RuntimeEngine } from "../types";

/**
 * A cell that runs past its timeout must not leave its container running:
 * killing the `run` client alone does not stop it (#113). Against a real
 * engine: VAULTORE_IT_ENGINE, default colima.
 *
 *   bun run --cwd packages/core test:integration
 */

const engine = IT_ENGINE as RuntimeEngine;
const binary = engine === "podman" ? "podman" : engine === "apple" ? "container" : "docker";

/** Names of the engine's containers, running or stopped, that match `name`. */
function containersNamed(name: string): string[] {
	const result = spawnSync(binary, ["ps", "-a", "--filter", `name=${name}`, "--format", "{{.Names}}"], {
		encoding: "utf8",
	});
	return result.stdout.split("\n").filter(Boolean);
}

describe("cell timeout on a real engine", { timeout: 120_000 }, () => {
	it.skipIf(engine === "apple")("kills and removes the container", async () => {
		const name = `vaultore-it-${randomBytes(4).toString("hex")}`;

		const result = await execContainer(nodeTimers, engine, {
			image: "oven/bun:1-alpine",
			command: ["sh", "-c", "sleep 60"],
			networkEnabled: false,
			timeout: 5_000,
			name,
		});

		expect(result.timedOut).toBe(true);
		// `--rm` removes the killed container; give the engine a moment.
		for (let i = 0; i < 20 && containersNamed(name).length > 0; i++) {
			await new Promise((resolve) => setTimeout(resolve, 500));
		}
		expect(containersNamed(name)).toEqual([]);
	});
});
