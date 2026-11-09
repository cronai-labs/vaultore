import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkflowExecutor } from "./index";
import { cellOutputsSource } from "../vault";
import type { CellOutput, PlatformAdapter } from "../types";

/**
 * `cell("id")` in a TS cell answers for cells that have an output and for
 * nothing else (#223). The outputs used to be an object literal looked up with
 * `in`, so every name an object inherits (`constructor`, `toString`) passed
 * for a cell, and an output of a cell named `__proto__` became the prototype
 * of the lookup and answered for ids that have no output at all.
 *
 * The engine is mocked, but the script is not: what the executor would hand
 * to the container is run here with Bun, which is what the image runs it
 * with. Matching the script's text would pass a lookup that is still wrong.
 */

vi.mock("../runtime", () => ({
	detectRuntimes: vi.fn(async () => ({ available: ["docker"], errors: new Map() })),
	execContainer: vi.fn(),
}));

import { execContainer } from "../runtime";

let scratch: string;
let scripts = 0;

beforeAll(() => {
	scratch = mkdtempSync(join(tmpdir(), "vaultore-cell-lookup-"));
});

afterAll(() => {
	rmSync(scratch, { recursive: true, force: true });
});

beforeEach(() => {
	vi.mocked(execContainer).mockReset();
	vi.mocked(execContainer).mockImplementation(async (_timers, _engine, opts) => {
		const file = join(scratch, `cell-${(scripts += 1)}.ts`);
		writeFileSync(file, opts.stdin ?? "");
		const result = spawnSync("bun", [file], {
			encoding: "utf8",
			env: { ...process.env, ...opts.env },
		});
		if (result.error) throw result.error;
		return {
			exitCode: result.status ?? 1,
			stdout: result.stdout,
			stderr: result.stderr,
			duration: 1,
			timedOut: false,
		};
	});
});

function vault(files: Record<string, string>): PlatformAdapter {
	return {
		platform: "cli",
		configDir: ".obsidian",
		readFile: async (path: string) => {
			if (!(path in files)) throw new Error(`File not found: ${path}`);
			return files[path] as string;
		},
		writeFile: async (path: string, content: string) => {
			files[path] = content;
		},
		exists: async (path: string) =>
			path in files || Object.keys(files).some((file) => file.startsWith(`${path}/`)),
		mkdirp: async () => undefined,
		listFiles: async () => [],
		getVaultRoot: async () => "/vault",
		resolveInVault: async (path: string) => path,
		getSetting: () => undefined,
		setSetting: async () => undefined,
		getSecret: async () => undefined,
		setSecret: async () => undefined,
		deleteSecret: async () => undefined,
		log: () => undefined,
	} as unknown as PlatformAdapter;
}

/** Runs a note of `ore:ts` cells, given as `[id, depends, code]`, and returns each cell's outcome. */
async function run(cells: [id: string, depends: string[], code: string][]) {
	const content = [
		"---\nore: true\nname: lookup\npermissions:\n  network: deny\n  vaultRead: deny\n  vaultWrite: deny\n---\n",
		...cells.map(
			([id, depends, code]) =>
				`\`\`\`ore:ts id=${id}${depends.length ? ` depends=[${depends.join(", ")}]` : ""}\n${code}\n\`\`\`\n`
		),
	].join("\n");
	const workflow = await new WorkflowExecutor().runWorkflow({
		platform: vault({ "wf.md": content }),
		workflowPath: "wf.md",
		content,
	});
	return (id: string) => {
		const output = workflow.outputs.get(id);
		return { status: output?.meta.status, value: output?.value, error: output?.meta.error };
	};
}

describe("cell() in a TS cell", { timeout: 60_000 }, () => {
	it("returns the output of the cell it names", async () => {
		const outcome = await run([
			["a", [], '({ x: 1, text: "ä $& `" })'],
			["b", ["a"], 'cell("a")'],
		]);

		expect(outcome("b")).toMatchObject({ status: "success", value: { x: 1, text: "ä $& `" } });
	});

	it.each(["constructor", "toString", "hasOwnProperty", "__proto__", "valueOf"])(
		'fails for cell("%s") when no cell has that id',
		async (name) => {
			const outcome = await run([
				["a", [], "1"],
				["b", ["a"], `cell(${JSON.stringify(name)})`],
			]);

			expect(outcome("b").status).toBe("error");
			expect(outcome("b").error).toContain(`Cell output not found: ${name}`);
		}
	);

	// The object literal `{"__proto__": {...}}` sets a prototype instead of a
	// key: the cell's output then answered for every name it holds.
	it("treats the output of a cell named __proto__ as that cell's output and nothing more", async () => {
		const outcome = await run([
			["__proto__", [], '({ injected: "from the prototype" })'],
			[
				"b",
				["__proto__"],
				'let other; try { other = cell("injected"); } catch (err) { other = String(err.message); }\n[cell("__proto__"), other]',
			],
		]);

		expect(outcome("b")).toMatchObject({
			status: "success",
			value: [{ injected: "from the prototype" }, "Cell output not found: injected"],
		});
	});
});

// The outputs reach the script as source text. Whatever a cell put out, and
// whatever a cell is called, must come back as data.
describe("cellOutputsSource", () => {
	const meta = { status: "success" as const, duration: 1, timestamp: "2026-01-01T00:00:00Z" };
	const outputs = (entries: [string, unknown][]) =>
		new Map<string, CellOutput>(entries.map(([cellId, value]) => [cellId, { cellId, value, meta }]));
	// Running the generated source is the test.
	const evaluate = (source: string) => new Function(`return ${source};`)() as Map<string, unknown>;

	it("gives every output back under its id", () => {
		const values: [string, unknown][] = [
			["text", "quote \" backtick ` dollar $& ${x} newline \n line separator \u2028 </script>"],
			["object", { nested: [1, null, { deep: true }] }],
			["nothing", null],
			["zero", 0],
		];

		expect(Array.from(evaluate(cellOutputsSource(outputs(values))).entries())).toEqual(values);
	});

	it.each(["__proto__", "constructor", "toString"])("keeps a cell named %s as an entry like any other", (id) => {
		const map = evaluate(cellOutputsSource(outputs([[id, { injected: true }]])));

		expect(Array.from(map.keys())).toEqual([id]);
		expect(map.get(id)).toEqual({ injected: true });
		expect(map.has("injected")).toBe(false);
	});

	// As before, when the outputs were a JSON object: a value JSON has no form
	// for is no entry, so `cell()` says the output was not found.
	it("leaves out an output that is undefined", () => {
		const map = evaluate(cellOutputsSource(outputs([["a", undefined], ["b", 1]])));

		expect(Array.from(map.keys())).toEqual(["b"]);
	});
});
