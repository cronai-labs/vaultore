import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WorkflowExecutor } from "./index";
import { filesystemPlatform, makeIntegrationVaultRoot } from "../testing/integration-vault";

/**
 * `cell("id")` answers for cells that have an output and for nothing else
 * (#223), in the image's own Bun. Needs a running engine: VAULTORE_IT_ENGINE,
 * default colima. The same cases run without a container in
 * cell-lookup.test.ts.
 *
 *   bun run --cwd packages/core test:integration
 */

let root: string;

beforeAll(() => {
	root = makeIntegrationVaultRoot();
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

async function run(cells: string) {
	const content = `---
ore: true
name: lookup
permissions:
  network: deny
  vaultRead: deny
  vaultWrite: deny
---

${cells}
`;
	writeFileSync(join(root, "lookup.md"), content);
	const workflow = await new WorkflowExecutor().runWorkflow({
		platform: filesystemPlatform(root),
		workflowPath: "lookup.md",
		content,
	});
	return (id: string) => {
		const output = workflow.outputs.get(id);
		return { status: output?.meta.status, value: output?.value, error: output?.meta.error };
	};
}

describe("cell() in a container", { timeout: 180_000 }, () => {
	it("fails for a name that only an object's prototype has", async () => {
		const outcome = await run(
			'```ore:ts id=a\n({ x: 1 })\n```\n\n```ore:ts id=b depends=[a]\ncell("constructor")\n```\n'
		);

		expect(outcome("a")).toMatchObject({ status: "success", value: { x: 1 } });
		expect(outcome("b").status).toBe("error");
		expect(outcome("b").error).toContain("Cell output not found: constructor");
	});

	// No cell can be called __proto__ (Ore §5.3), but an output of an earlier run
	// is named by a callout in the note, which is text anyone can write.
	it("gives an output recorded under __proto__ no say over other ids", async () => {
		const record = "_vaultore/runs/lookup/earlier/record.json";
		mkdirSync(join(root, "_vaultore/runs/lookup/earlier"), { recursive: true });
		writeFileSync(
			join(root, record),
			JSON.stringify({
				cellId: "__proto__",
				value: { injected: "from the prototype" },
				meta: { status: "success", duration: 1, timestamp: "2026-01-01T00:00:00.000Z" },
			})
		);
		const outcome = await run(
			'```ore:ts id=b\n' +
				'let other; try { other = cell("injected"); } catch (err) { other = String(err.message); }\n' +
				'[cell("__proto__"), other]\n```\n\n' +
				`> [!ore-output] __proto__\n> json: [[${record}]]\n`
		);

		expect(outcome("b")).toMatchObject({
			status: "success",
			value: [{ injected: "from the prototype" }, "Cell output not found: injected"],
		});
	});
});
