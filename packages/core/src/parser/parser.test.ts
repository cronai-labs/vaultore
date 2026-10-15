import { describe, expect, it } from "vitest";
import { TemplateInterpolator, WorkflowParser, isWorkflowFrontmatter } from "./index";

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
    const outputs = new Map([
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
