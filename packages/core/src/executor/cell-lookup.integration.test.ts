import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rmSync, writeFileSync } from "node:fs";
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

	it("gives a cell named __proto__ its output and no say over other ids", async () => {
		const outcome = await run(
			'```ore:ts id=__proto__\n({ injected: "from the prototype" })\n```\n\n' +
				'```ore:ts id=b depends=[__proto__]\n' +
				'let other; try { other = cell("injected"); } catch (err) { other = String(err.message); }\n' +
				'[cell("__proto__"), other]\n```\n'
		);

		expect(outcome("b")).toMatchObject({
			status: "success",
			value: [{ injected: "from the prototype" }, "Cell output not found: injected"],
		});
	});
});
