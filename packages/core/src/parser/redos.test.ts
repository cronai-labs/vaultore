import { describe, expect, it } from "vitest";
import { WorkflowParser, extractWikilink, stripLeading, stripTrailing } from "./index";

/**
 * CodeQL flagged six polynomial-backtracking regexes (js/polynomial-redos) in
 * this package. The input really is uncontrolled — workflow notes arrive by
 * sync and are re-parsed on every metadata-cache change — so each fix is
 * covered twice: the parse result must be unchanged for ordinary input, and the
 * pathological input CodeQL named must complete quickly.
 */

const BUDGET_MS = 1_000;

function timed(fn: () => void): number {
	const started = performance.now();
	fn();
	return performance.now() - started;
}

function note(body: string): string {
	return `---\nore: true\nname: T\n---\n\n${body}`;
}

describe("CELL_REGEX", () => {
	// Was `\s*`, which matches newlines: an attribute-less fence consumed the
	// first line of code as its attribute string, so `const id = 1;` was read as
	// `id=1` and the cell parsed "successfully" with that line deleted. It is
	// now correctly reported as missing an id.
	it("does not read the first line of code as the fence's attributes", () => {
		expect(() =>
			new WorkflowParser().parse(note("```ore:ts\nconst id = 1;\nid;\n```\n"), "t.md")
		).toThrow(/missing 'id'/);
	});

	it("still reads attributes on the fence line", () => {
		const workflow = new WorkflowParser().parse(
			note("```ore:ts id=a\n1;\n```\n\n```ore:ts id=hello depends=[a]\n2;\n```\n"),
			"t.md"
		);

		expect(workflow.cells[1]?.attributes.id).toBe("hello");
		expect(workflow.cells[1]?.attributes.depends).toEqual(["a"]);
	});

	it("is fast on the input CodeQL named (unterminated fence, many spaces)", () => {
		const content = note("```ore:ts" + " ".repeat(100_000));
		expect(timed(() => new WorkflowParser().parse(content, "t.md"))).toBeLessThan(BUDGET_MS);
	});

	it("is fast on many newline-space repetitions", () => {
		const content = note("```ore:ts\n" + "\n ".repeat(50_000));
		expect(timed(() => new WorkflowParser().parse(content, "t.md"))).toBeLessThan(BUDGET_MS);
	});
});

describe("CELL_ATTR_REGEX", () => {
	it("is fast on a long unbroken word", () => {
		const content = note("```ore:ts id=x " + "a".repeat(200_000) + "\n1;\n```\n");
		expect(timed(() => new WorkflowParser().parse(content, "t.md"))).toBeLessThan(BUDGET_MS);
	});

	it("still parses quoted, bracketed and bare values", () => {
		const workflow = new WorkflowParser().parse(
			note(
				"```ore:ts id=b\n1;\n```\n\n```ore:ts id=c\n2;\n```\n\n" +
					'```ore:ts id=a depends=[b,c] stdin="x y" model=\'m\' timeout=30\n3;\n```\n'
			),
			"t.md"
		);

		const attrs = workflow.cells[2]?.attributes as Record<string, unknown>;
		expect(attrs.id).toBe("a");
		expect(attrs.depends).toEqual(["b", "c"]);
		expect(attrs.stdin).toBe("x y"); // double-quoted value containing a space
		expect(attrs.model).toBe("m"); // single-quoted
		expect(attrs.timeout).toBe(30); // bare
	});
});

describe("OUTPUT_REGEX", () => {
	it("is fast on repeated unterminated output comments", () => {
		const content = note("<!--ore:output:!".repeat(50_000));
		expect(timed(() => new WorkflowParser().parse(content, "t.md"))).toBeLessThan(BUDGET_MS);
	});
});

describe("extractWikilink", () => {
	it("returns the first link target", () => {
		expect(extractWikilink("> json: [[_vaultore/runs/a/b.json]]")).toBe(
			"_vaultore/runs/a/b.json"
		);
	});

	it("returns undefined when there is no closed link", () => {
		expect(extractWikilink("> json: [[unterminated")).toBeUndefined();
		expect(extractWikilink("> json: nothing here")).toBeUndefined();
		expect(extractWikilink("> json: [[]]")).toBeUndefined();
	});

	it("is fast on many unterminated openers", () => {
		const line = "[[".repeat(200_000);
		expect(timed(() => extractWikilink(line))).toBeLessThan(BUDGET_MS);
	});
});

describe("separator helpers", () => {
	it("strip only at the intended end", () => {
		expect(stripTrailing("a/b/c///", "/")).toBe("a/b/c");
		expect(stripLeading("///a/b", "/")).toBe("a/b");
		expect(stripTrailing("a/b/c", "/")).toBe("a/b/c");
		expect(stripLeading("a/b/c", "/")).toBe("a/b/c");
		expect(stripTrailing("///", "/")).toBe("");
	});

	it("are linear on long separator runs", () => {
		const value = "x" + "/".repeat(400_000);
		expect(timed(() => stripTrailing(value, "/"))).toBeLessThan(BUDGET_MS);
	});
});
