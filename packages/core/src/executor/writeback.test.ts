import { describe, expect, it } from "vitest";
import { WorkflowExecutor } from "./index";
import type { CellOutput, PlatformAdapter } from "../types";

/**
 * The run holds a snapshot from before it started. Writing that snapshot back
 * discarded anything typed while the run was in flight — once per cell, and
 * container and AI cells are slow enough to make that easy to hit.
 */

const NOTE = `---
ore: true
name: T
---

# T

\`\`\`ore:ts id=a
1;
\`\`\`
`;

function output(cellId: string, value: unknown): CellOutput {
	return {
		cellId,
		value,
		meta: { status: "success", duration: 1, timestamp: new Date().toISOString() },
	} as CellOutput;
}

/** In-memory vault exposing only what writeBackOutput touches. */
function vault(files: Record<string, string>) {
	const writes: string[] = [];
	const platform = {
		exists: async (path: string) => path in files,
		readFile: async (path: string) => {
			if (!(path in files)) throw new Error(`File not found: ${path}`);
			return files[path] as string;
		},
		writeFile: async (path: string, content: string) => {
			writes.push(path);
			files[path] = content;
		},
	} as unknown as PlatformAdapter;
	return { platform, files, writes };
}

// writeBackOutput is private; exercising it through the class keeps the test
// honest about how the executor actually calls it.
function writeBack(
	executor: WorkflowExecutor,
	platform: PlatformAdapter,
	path: string,
	lastKnown: string,
	result: CellOutput
): Promise<string> {
	return (
		executor as unknown as {
			writeBackOutput: (
				p: PlatformAdapter,
				path: string,
				last: string,
				r: CellOutput
			) => Promise<string>;
		}
	).writeBackOutput(platform, path, lastKnown, result);
}

describe("writeBackOutput", () => {
	it("keeps an edit made while the run was in flight", async () => {
		const edited = NOTE.replace("# T", "# T\n\nA paragraph the user typed mid-run.");
		const { platform, files } = vault({ "t.md": edited });

		// The executor still holds the pre-edit snapshot.
		await writeBack(new WorkflowExecutor(), platform, "t.md", NOTE, output("a", 42));

		expect(files["t.md"]).toContain("A paragraph the user typed mid-run.");
		expect(files["t.md"]).toContain("[!ore-output] a");
	});

	it("does not recreate a note deleted mid-run", async () => {
		const { platform, files, writes } = vault({});

		const result = await writeBack(
			new WorkflowExecutor(),
			platform,
			"t.md",
			NOTE,
			output("a", 42)
		);

		expect(writes).toEqual([]);
		expect("t.md" in files).toBe(false);
		expect(result).toBe(NOTE); // caller keeps its last known content
	});

	it("falls back to the last known content when the note cannot be read", async () => {
		const platform = {
			exists: async () => true,
			readFile: async () => {
				throw new Error("EACCES");
			},
			writeFile: async () => undefined,
		} as unknown as PlatformAdapter;

		const result = await writeBack(
			new WorkflowExecutor(),
			platform,
			"t.md",
			NOTE,
			output("a", 42)
		);

		expect(result).toContain("[!ore-output] a");
	});

	it("replaces a previous output for the same cell rather than appending", async () => {
		const { platform, files } = vault({ "t.md": NOTE });
		const executor = new WorkflowExecutor();

		await writeBack(executor, platform, "t.md", NOTE, output("a", "first"));
		const afterFirst = files["t.md"] as string;
		await writeBack(executor, platform, "t.md", afterFirst, output("a", "second"));

		const occurrences = (files["t.md"] as string).match(/\[!ore-output\] a/g) ?? [];
		expect(occurrences).toHaveLength(1);
	});

	it("preserves a concurrent edit across successive cells", async () => {
		const { platform, files } = vault({ "t.md": NOTE });
		const executor = new WorkflowExecutor();

		let last = await writeBack(executor, platform, "t.md", NOTE, output("a", 1));

		// User edits the note between two cells.
		files["t.md"] = (files["t.md"] as string).replace("# T", "# T\n\nlater edit");

		last = await writeBack(executor, platform, "t.md", last, output("a", 2));

		expect(files["t.md"]).toContain("later edit");
		expect(last).toContain("later edit");
	});
});
