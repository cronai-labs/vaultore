import { describe, expect, it } from "vitest";
import { TemplateInterpolator, WorkflowParser } from "./index";

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
