import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { WorkflowExecutor } from "../executor";
import type { PlatformRequest } from "../types";
import { filesystemPlatform, makeIntegrationVaultRoot } from "../testing/integration-vault";

/**
 * fixtures/security/ (#341): each note probes one boundary of the sandbox
 * from inside a real container and fails its cell, naming what crossed it,
 * when the boundary does not hold. setup.json gives the vault it runs in and
 * what it expects. The probes live in the notes alone, so a person can run
 * them by hand on any engine. Needs a running engine (VAULTORE_IT_ENGINE,
 * default colima).
 *
 *   bun run --cwd packages/core test:integration -t security
 */

interface FixtureSetup {
	files: Record<string, string>;
	links?: Record<string, "outside">;
	stateDirectory?: string;
	cells: Record<string, "success" | "error">;
	unchanged: string[];
	absent: string[];
}

const FIXTURES = resolve(__dirname, "../../../../fixtures/security");
const SETUP = JSON.parse(readFileSync(join(FIXTURES, "setup.json"), "utf8")) as Record<string, FixtureSetup | string>;
const OUTSIDE_SECRET = "outside the vault";

const made: string[] = [];
afterEach(() => {
	for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("security fixtures", { timeout: 120_000 }, () => {
	it("setup.json covers every fixture, and only those", () => {
		const notes = readdirSync(FIXTURES).filter((name) => name.endsWith(".md")).sort();
		expect(Object.keys(SETUP).filter((key) => key !== "$comment").sort()).toEqual(notes);
	});

	for (const [file, entry] of Object.entries(SETUP)) {
		if (typeof entry === "string") continue;
		const setup = entry;

		it(`${file} holds in a real container`, async () => {
			const vault = makeIntegrationVaultRoot();
			const outside = makeIntegrationVaultRoot();
			made.push(vault, outside);
			for (const [path, content] of Object.entries(setup.files)) {
				mkdirSync(dirname(join(vault, path)), { recursive: true });
				writeFileSync(join(vault, path), content);
			}
			writeFileSync(join(outside, "secret.md"), OUTSIDE_SECRET);
			for (const link of Object.keys(setup.links ?? {})) symlinkSync(outside, join(vault, link));
			const content = readFileSync(join(FIXTURES, file), "utf8");
			writeFileSync(join(vault, file), content);

			const requests: PlatformRequest[] = [];
			const platform = {
				...filesystemPlatform(vault, {
					settings: { "vaultore.defaultProvider": "openai" },
					secrets: { "openai.apiKey": "test-key" },
					request: async (request) => {
						requests.push(request);
						return { status: 200, text: JSON.stringify({ choices: [{ message: { content: "OK" } }] }) };
					},
				}),
				...(setup.stateDirectory ? { stateDirectory: join(vault, setup.stateDirectory) } : {}),
			};
			const before = Object.fromEntries(setup.unchanged.map((path) => [path, readFileSync(join(vault, path), "utf8")]));

			const workflow = await new WorkflowExecutor().runWorkflow({ platform, workflowPath: file, content });

			const statuses = Object.fromEntries(
				Object.keys(setup.cells).map((id) => [id, workflow.outputs.get(id)?.meta.status])
			);
			const values = Object.fromEntries(Object.keys(setup.cells).map((id) => [id, workflow.outputs.get(id)?.value]));
			expect(statuses, JSON.stringify(values)).toEqual(setup.cells);
			for (const id of Object.keys(setup.cells).filter((id) => setup.cells[id] === "success")) {
				expect(String(values[id])).toMatch(/^held: /);
			}
			for (const id of Object.keys(setup.cells).filter((id) => setup.cells[id] === "error")) {
				expect(String(values[id])).toMatch(/hidden from cells/);
			}
			expect(requests).toEqual([]);
			for (const path of setup.unchanged) expect(readFileSync(join(vault, path), "utf8"), path).toBe(before[path]);
			for (const path of setup.absent) expect(existsSync(join(vault, path)), path).toBe(false);
			expect(readdirSync(outside)).toEqual(["secret.md"]);
		});
	}
});
