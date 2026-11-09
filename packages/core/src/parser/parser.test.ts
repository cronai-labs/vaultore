import { describe, expect, it, vi } from "vitest";
import { TemplateInterpolator, WorkflowParser, isWorkflowFrontmatter } from "./index";
import type { CellOutput } from "../types";

describe("WorkflowParser", () => {
  it("parses frontmatter, cells, and outputs", () => {
    const content = `---
ore: true
name: Test Workflow
permissions:
  network: deny
---

# Title

\`\`\`ore:ts id=hello
const x = 1;
x + 1;
\`\`\`

\`\`\`ore:ai id=ask depends=[hello]
Hello {{hello}}
\`\`\`

<!-- ore:output:hello
2
meta:
  status: success
  duration: 10ms
  timestamp: 2026-01-01T00:00:00Z
-->
`;

    const parser = new WorkflowParser();
    const workflow = parser.parse(content, "Workflows/test.md");

    expect(workflow.frontmatter.name).toBe("Test Workflow");
    expect(workflow.cells).toHaveLength(2);
    expect(workflow.cells[0]?.attributes.id).toBe("hello");
    expect(workflow.cells[1]?.attributes.depends).toEqual(["hello"]);

    const output = workflow.outputs.get("hello");
    expect(output?.value).toBe(2);
    expect(output?.meta.status).toBe("success");
    expect(output?.meta.duration).toBe(10);
    expect(output?.meta.timestamp).toBe("2026-01-01T00:00:00Z");
  });
});

// The runtime installs a kill timer only for a timeout above zero, so a value
// that is not a positive number used to leave the container unbounded (#45).
describe("WorkflowParser cell timeout", () => {
  const parser = new WorkflowParser();
  const cell = (timeout: string) =>
    `\`\`\`ore:shell id=slow timeout=${timeout}\nsleep 60\n\`\`\`\n`;

  it.each([
    ["30", 30],
    ["0.5", 0.5],
    ['"90"', 90],
  ])("reads timeout=%s as seconds", (written, seconds) => {
    expect(parser.parseCells(cell(written))[0]?.attributes.timeout).toBe(seconds);
  });

  it("leaves the timeout to the workflow when the cell names none", () => {
    const cells = parser.parseCells("```ore:shell id=slow\nsleep 60\n```\n");
    expect(cells[0]?.attributes.timeout).toBeUndefined();
  });

  it("ignores the attribute on an AI cell, which has no container to stop", () => {
    const cells = parser.parseCells("```ore:ai id=ask timeout=2m\nHello\n```\n");
    expect(cells[0]?.attributes.timeout).toBeUndefined();
  });

  it.each(["abc", "2m", "30s", "0", "-5", "1e3"])(
    "refuses timeout=%s and names the cell",
    (written) => {
      expect(() => parser.parseCells(cell(written))).toThrow(
        `Cell slow has an invalid timeout "${written}": expected a positive number of seconds`
      );
    }
  );
});

// A cycle has no order to run in. It used to fall back to document order, with
// each cell reading its dependency's output from an earlier run (#45).
describe("WorkflowParser dependency cycles", () => {
  const parser = new WorkflowParser();
  const note = (...cells: Array<[id: string, depends?: string]>) =>
    cells
      .map(
        ([id, depends]) =>
          `\`\`\`ore:ts id=${id}${depends ? ` depends=[${depends}]` : ""}\n1;\n\`\`\`\n`
      )
      .join("\n");

  it("refuses a cell that depends on itself", () => {
    expect(() => parser.parseCells(note(["a", "a"]))).toThrow("Cell a depends on itself");
  });

  it("refuses a cycle and names its cells in dependency order", () => {
    expect(() =>
      parser.parseCells(note(["a", "c"], ["b", "a"], ["c", "b"]))
    ).toThrow("Dependency cycle: a depends on c, c depends on b, b depends on a");
  });

  it("names the cycle, not the cells that lead into it", () => {
    expect(() =>
      parser.parseCells(note(["start"], ["entry", "start, x"], ["x", "y"], ["y", "x"]))
    ).toThrow("Dependency cycle: x depends on y, y depends on x");
  });

  it("reports the cycle at the line of its first cell", () => {
    try {
      parser.parseCells(note(["start"], ["x", "y"], ["y", "x"]));
      expect.unreachable("a cycle must not parse");
    } catch (err) {
      expect((err as { line?: number }).line).toBe(5);
    }
  });

  it("finds a cycle at the end of a long chain", () => {
    const length = 1_000;
    const chain = Array.from({ length }, (_, i): [string, string?] => [
      `c${i}`,
      i + 1 < length ? `c${i + 1}` : undefined,
    ]);
    expect(parser.parseCells(note(...chain))).toHaveLength(length);

    chain[length - 1] = [`c${length - 1}`, `c${length - 2}`];
    expect(() => parser.parseCells(note(...chain))).toThrow(
      `Dependency cycle: c${length - 2} depends on c${length - 1}, c${length - 1} depends on c${length - 2}`
    );
  });

  it("accepts a diamond, where two cells share a dependency", () => {
    const cells = parser.parseCells(
      note(["root"], ["left", "root"], ["right", "root"], ["join", "left, right"])
    );
    expect(cells.map((cell) => cell.attributes.id)).toEqual(["root", "left", "right", "join"]);
  });
});

// The meta block sits in the note, where anyone can edit it (#121).
describe("WorkflowParser.parseOutputs meta block", () => {
  const block = (meta: string) => `<!-- ore:output:hello\n2\nmeta:\n${meta}-->\n`;

  it("reads a block with only blank lines as no meta", () => {
    const outputs = new WorkflowParser().parseOutputs(block("  \n"));
    expect(outputs.get("hello")?.value).toBe(2);
    expect(outputs.get("hello")?.meta.status).toBe("success");
  });

  it("skips an output whose meta has the wrong types, naming the field", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const outputs = new WorkflowParser().parseOutputs(block("  status: done\n  duration: [1]\n"));
      expect(outputs.has("hello")).toBe(false);
      const message = warn.mock.calls.map((call) => call.map(String).join(" ")).join("\n");
      expect(message).toMatch(/hello/);
      expect(message).toMatch(/status/);
      expect(message).toMatch(/duration/);
    } finally {
      warn.mockRestore();
    }
  });

  it("keeps the cache and error fields of a valid block", () => {
    const outputs = new WorkflowParser().parseOutputs(
      block("  status: error\n  duration: 1.5s\n  error: exit 1\n  cache: hit\n")
    );
    expect(outputs.get("hello")?.meta).toMatchObject({
      status: "error",
      duration: 1500,
      error: "exit 1",
      cache: "hit",
    });
  });
});

// Hosts that already hold parsed frontmatter (Obsidian's metadata cache) need
// the same "is this a workflow" rule as isWorkflow(), without the raw text.
describe("isWorkflowFrontmatter", () => {
  it("accepts only ore: true", () => {
    expect(isWorkflowFrontmatter({ ore: true })).toBe(true);
    expect(isWorkflowFrontmatter({ ore: "true" })).toBe(false);
    expect(isWorkflowFrontmatter({ ore: false })).toBe(false);
    expect(isWorkflowFrontmatter({ title: "Note" })).toBe(false);
    expect(isWorkflowFrontmatter(undefined)).toBe(false);
    expect(isWorkflowFrontmatter(null)).toBe(false);
  });

  it("agrees with isWorkflow on note text", () => {
    const parser = new WorkflowParser();
    for (const fm of ["ore: true", "ore: 'true'", "ore: false", "title: x"]) {
      const content = `---\n${fm}\n---\n`;
      expect(parser.isWorkflow(content)).toBe(
        isWorkflowFrontmatter(parser.parseRawFrontmatter(content))
      );
    }
  });
});

describe("TemplateInterpolator", () => {
  it("replaces hyphenated cell IDs", () => {
    const outputs = new Map<string, CellOutput>([
      [
        "fetch-pages",
        {
          cellId: "fetch-pages",
          value: { ok: true },
          meta: { status: "success", duration: 1, timestamp: "now" },
        },
      ],
    ]);

    const interpolator = new TemplateInterpolator();
    const result = interpolator.interpolate(
      "Payload: {{fetch-pages}}",
      outputs
    );

    expect(result).toContain("\"ok\": true");
  });
});

describe("TemplateInterpolator.interpolateAsync", () => {
  function outputs(entries: Record<string, unknown>) {
    return new Map(
      Object.entries(entries).map(([cellId, value]) => [
        cellId,
        {
          cellId,
          value,
          meta: { status: "success" as const, duration: 1, timestamp: "now" },
        },
      ])
    );
  }

  it("resolves note references written in the cell's own template", async () => {
    const result = await new TemplateInterpolator().interpolateAsync(
      "Summarise: {{note:a.md}}",
      outputs({}),
      async (path) => `content of ${path}`
    );

    expect(result).toBe("Summarise: content of a.md");
  });

  // Fetched text that contains the placeholder syntax must not pull a note into
  // a prompt bound for a third party (#67).
  it("inserts upstream output verbatim and never scans it for note references", async () => {
    const reads: string[] = [];
    const result = await new TemplateInterpolator().interpolateAsync(
      "Summarise: {{fetched}}",
      outputs({ fetched: "page text {{note:Private/secret.md}}" }),
      async (path) => {
        reads.push(path);
        return "SECRET";
      }
    );

    expect(reads).toEqual([]);
    expect(result).toBe("Summarise: page text {{note:Private/secret.md}}");
  });

  it("inserts note content literally, including replacement patterns", async () => {
    const result = await new TemplateInterpolator().interpolateAsync(
      "A {{note:a.md}} B",
      outputs({}),
      async () => "$& $` $'"
    );

    expect(result).toBe("A $& $` $' B");
  });

  it("propagates a failed note read instead of sending the placeholder", async () => {
    await expect(
      new TemplateInterpolator().interpolateAsync(
        "Summarise: {{note:missing.md}}",
        outputs({}),
        async () => {
          throw new Error("File not found: missing.md");
        }
      )
    ).rejects.toThrow("missing.md");
  });
});
