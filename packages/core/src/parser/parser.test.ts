import { describe, expect, it, vi } from "vitest";
import {
  OutputSerializer,
  TemplateInterpolator,
  WorkflowParser,
  isWorkflowFrontmatter,
} from "./index";
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
        `Cell slow has an invalid timeout "${written}": expected a number of seconds greater than 0 and at most 86400`
      );
    }
  );

  // A day is the most a time limit can be (Ore). Far above it the limit also
  // stops being one: past 2^31-1 ms the timer fires at once (#222).
  it("reads a timeout of exactly a day", () => {
    expect(parser.parseCells(cell("86400"))[0]?.attributes.timeout).toBe(86400);
  });

  it.each(["86401", "86400.5", "2147484", "99999999999999999999"])(
    "refuses timeout=%s, which is more than a day",
    (written) => {
      expect(() => parser.parseCells(cell(written))).toThrow(
        `Cell slow has an invalid timeout "${written}": expected a number of seconds greater than 0 and at most 86400`
      );
    }
  );
});

// The front matter's limits are what a container cell runs under when the cell
// names none. A value that switches a limit off (`timeout: 0`, `cpuLimit: 0`,
// `memoryLimit: "0"`) used to be passed on or dropped without a word (#210, #222).
describe("WorkflowParser container limits in front matter", () => {
  const parser = new WorkflowParser();
  const note = (runtime: string) =>
    `---\nore: true\nname: Limits\nruntime:\n  ${runtime}\n---\n\n\`\`\`ore:shell id=a\necho hi\n\`\`\`\n`;
  const runtimeOf = (runtime: string) => parser.parseFrontmatter(note(runtime)).runtime;

  it.each([
    ["timeout: 60", { timeout: 60 }],
    ["timeout: 0.5", { timeout: 0.5 }],
    ["timeout: 86400", { timeout: 86400 }],
    ["cpuLimit: 2", { cpuLimit: 2 }],
    ["cpuLimit: 0.5", { cpuLimit: 0.5 }],
    ['memoryLimit: "512m"', { memoryLimit: "512m" }],
    ['memoryLimit: "1.5g"', { memoryLimit: "1.5g" }],
    ['memoryLimit: "1GiB"', { memoryLimit: "1GiB" }],
    ['memoryLimit: "268435456"', { memoryLimit: "268435456" }],
  ])("reads %s", (written, expected) => {
    expect(runtimeOf(written)).toEqual(expected);
  });

  it("leaves the limits to the defaults when the note names none", () => {
    expect(runtimeOf("image: alpine:3.19")).toEqual({ image: "alpine:3.19" });
  });

  it.each([
    ["timeout: 0", "0"],
    ["timeout: -5", "-5"],
    ["timeout: 86401", "86401"],
    ["timeout: 2147484", "2147484"],
    ["timeout: .inf", "Infinity"],
    ["timeout: .nan", "NaN"],
    ['timeout: "60"', '"60"'],
    ["timeout: 2m", '"2m"'],
    ["timeout: ~", "null"],
  ])("refuses %s, naming the key and the value", (written, value) => {
    expect(() => runtimeOf(written)).toThrow(
      `Invalid frontmatter: runtime.timeout: expected a number of seconds greater than 0 and at most 86400, got ${value}`
    );
  });

  it.each([
    ["cpuLimit: 0", "0"],
    ["cpuLimit: -1", "-1"],
    ["cpuLimit: .inf", "Infinity"],
    ['cpuLimit: "2"', '"2"'],
  ])("refuses %s, naming the key and the value", (written, value) => {
    expect(() => runtimeOf(written)).toThrow(
      `Invalid frontmatter: runtime.cpuLimit: expected a number of CPUs greater than 0, got ${value}`
    );
  });

  // The engines read `0` as "no limit", whatever its unit.
  it.each([
    ['memoryLimit: ""', '""'],
    ['memoryLimit: "  "', '"  "'],
    ['memoryLimit: "0"', '"0"'],
    ['memoryLimit: "0m"', '"0m"'],
    ['memoryLimit: "0.0g"', '"0.0g"'],
    ['memoryLimit: "-512m"', '"-512m"'],
    ['memoryLimit: "lots"', '"lots"'],
    ["memoryLimit: 512", "512"],
  ])("refuses %s, naming the key and the value", (written, value) => {
    expect(() => runtimeOf(written)).toThrow(
      `Invalid frontmatter: runtime.memoryLimit: expected an amount of memory greater than zero, such as "512m", got ${value}`
    );
  });
});

// An output goes under the cell that produced it. That cell was found with a
// pattern over the fence line, which took any id that starts with the wanted
// one: the output of `fetch` landed under `fetch-summary` (#45).
describe("OutputSerializer.updateWorkflowOutput", () => {
  const serializer = new OutputSerializer();
  const output = (cellId: string): CellOutput => ({
    cellId,
    value: "v",
    meta: { status: "success", duration: 1, timestamp: "2026-01-01T00:00:00Z" },
  });
  const callout = (cellId: string) =>
    `> [!ore-output] ${cellId}\n> status: success | duration: 1ms | at: 2026-01-01T00:00:00Z`;
  const fence = (attrs: string) => `\`\`\`ore:ts ${attrs}\n1;\n\`\`\``;

  it("writes the output under the cell, not under one whose id starts the same", () => {
    const note = `${fence("id=fetch-summary depends=[fetch]")}\n\n${fence("id=fetch")}\n`;

    expect(serializer.updateWorkflowOutput(note, output("fetch"))).toBe(
      `${fence("id=fetch-summary depends=[fetch]")}\n\n${fence("id=fetch")}\n\n${callout("fetch")}\n`
    );
  });

  it("tells quoted ids apart the same way", () => {
    const note = `${fence('id="fetch-summary"')}\n\n${fence("id='fetch'")}\n`;

    expect(serializer.updateWorkflowOutput(note, output("fetch"))).toBe(
      `${fence('id="fetch-summary"')}\n\n${fence("id='fetch'")}\n\n${callout("fetch")}\n`
    );
  });

  it("does not take another attribute for the id", () => {
    const note = `${fence('id=other grid=fetch stdin="x id=fetch"')}\n\n${fence("id=fetch")}\n`;

    expect(serializer.updateWorkflowOutput(note, output("fetch"))).toBe(
      `${fence('id=other grid=fetch stdin="x id=fetch"')}\n\n${fence("id=fetch")}\n\n${callout("fetch")}\n`
    );
  });

  it("gives the same note when the same output is written twice", () => {
    const note = `${fence("id=fetch-summary")}\n\n${fence("id=fetch")}\n\nEnd.\n`;
    const once = serializer.updateWorkflowOutput(note, output("fetch"));

    expect(serializer.updateWorkflowOutput(once, output("fetch"))).toBe(once);
  });

  it("keeps each output under its own cell when both are written", () => {
    const note = `${fence("id=fetch-summary")}\n\n${fence("id=fetch")}\n`;
    const both = serializer.updateWorkflowOutput(
      serializer.updateWorkflowOutput(note, output("fetch")),
      output("fetch-summary")
    );

    const positions = [
      "id=fetch-summary\n",
      "[!ore-output] fetch-summary\n",
      "id=fetch\n",
      "[!ore-output] fetch\n",
    ].map((text) => both.indexOf(text));

    expect(positions).not.toContain(-1);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(both.match(/\[!ore-output\]/g)).toHaveLength(2);
  });

  it("appends the output when the note has no such cell", () => {
    const note = `${fence("id=fetch-summary")}\n`;

    expect(serializer.updateWorkflowOutput(note, output("fetch"))).toBe(
      `${fence("id=fetch-summary")}\n\n${callout("fetch")}\n`
    );
  });
});

// An id names the cell's output files and is how other cells refer to it. Ore
// 0.2 (§5.3) fixes its form, so that it is a safe file name on every system and
// cannot be the run's own record or another cell's file.
describe("WorkflowParser cell ids", () => {
  const parser = new WorkflowParser();
  const note = (...ids: string[]) =>
    ids.map((id) => `\`\`\`ore:ts id=${id}\n1;\n\`\`\`\n`).join("\n");
  const ids = (...written: string[]) =>
    parser.parseCells(note(...written)).map((cell) => cell.attributes.id);

  it("accepts letters, digits, underscore and hyphen after a letter or digit", () => {
    const allowed = ["fetch", "Fetch2", "9lives", "a-b_c", "x", "writeNotes", "a".repeat(64)];
    expect(ids(...allowed)).toEqual(allowed);
  });

  it("refuses an id longer than 64 characters and says how long it is", () => {
    expect(() => ids("a".repeat(65))).toThrow(
      `Cell id "${"a".repeat(65)}" has 65 characters: an id has at most 64`
    );
  });

  it.each([
    ["_private", "_"],
    ["-rf", "-"],
    ["--help", "-"],
  ])("refuses %s, which does not start with a letter or digit", (id, first) => {
    expect(() => ids(id)).toThrow(
      `Cell id "${id}" starts with "${first}": an id starts with a letter or digit`
    );
  });

  it.each([
    ["fetch.raw", "."],
    ["a/b", "/"],
    ["café", "é"],
    ["größe", "ö"],
    ["a:b", ":"],
    ["price$", "$"],
  ])("refuses %s, which holds a character an id cannot", (id, bad) => {
    expect(() => ids(id)).toThrow(
      `Cell id "${id}" contains "${bad}": an id holds only the letters A-Z and a-z, digits, "_" and "-"`
    );
  });

  it("matches the letters exactly, not whatever counts as a letter somewhere", () => {
    // U+0130, U+212A and a full-width digit: letters or digits to Unicode,
    // not to Ore.
    for (const id of ["İd", "Kelvin", "a１"]) {
      expect(() => ids(id)).toThrow(/an id (holds only|starts with)/);
    }
  });

  it.each(["run", "Run", "RUN"])("refuses %s, the name of the run's own record", (id) => {
    expect(() => ids(id)).toThrow(
      `Cell id "${id}" is reserved: its output would be run.json, the run's own record`
    );
  });

  it.each(["con", "PRN", "Aux", "nul", "com0", "COM1", "com9", "lpt0", "Lpt9"])(
    "refuses %s, a device name on Windows",
    (id) => {
      expect(() => ids(id)).toThrow(
        `Cell id "${id}" is reserved: Windows keeps this name for a device, so it cannot be a file name there`
      );
    }
  );

  it("accepts names that only look like a device name or like run", () => {
    const allowed = ["com10", "lpt", "com", "console", "nul1", "runner", "rerun", "run-1"];
    expect(ids(...allowed)).toEqual(allowed);
  });

  it("refuses two ids that differ only in letter case, naming both", () => {
    expect(() => ids("fetch", "other", "Fetch")).toThrow(
      "Cells fetch and Fetch differ only in letter case, and their output files are one file where case is ignored: rename one"
    );
  });

  it("reports ids that differ only in letter case at the second cell", () => {
    try {
      ids("fetch", "Fetch");
      expect.unreachable("ids that differ only in case must not parse");
    } catch (err) {
      expect((err as { line?: number }).line).toBe(5);
    }
  });

  it("still compares ids exactly: depends=[Fetch] does not name a cell fetch", () => {
    const content = "```ore:ts id=fetch\n1;\n```\n\n```ore:ts id=report depends=[Fetch]\n2;\n```\n";
    expect(() => parser.parseCells(content)).toThrow("Cell report depends on unknown cell: Fetch");
  });

  it("reports a bad id at the line of its cell", () => {
    try {
      ids("fine", "not.fine");
      expect.unreachable("an id with a dot must not parse");
    } catch (err) {
      expect((err as { line?: number }).line).toBe(5);
    }
  });

  it("still calls an empty id missing", () => {
    expect(() => parser.parseCells('```ore:ts id=""\n1;\n```\n')).toThrow(/missing 'id' attribute/);
  });
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

// What VaultOre reads beyond what Ore 0.2 asks for, as
// specs/ore-implementation.md lists it under "Beyond the specification". The
// cases are that list's examples: when one changes, the document changes too.
describe("WorkflowParser beyond the specification", () => {
  const parser = new WorkflowParser();
  const attributes = (fences: string[]) =>
    parser
      .parseCells(fences.map((fence) => `\`\`\`ore:${fence}\necho x\n\`\`\`\n`).join("\n"))
      .map((cell) => cell.attributes);

  it.each(['timeout="30"', "timeout='30'", "timeout=[30]"])(
    "reads %s as 30 seconds",
    (written) => {
      expect(attributes([`shell id=a ${written}`])[0]?.timeout).toBe(30);
    }
  );

  it.each(['id="a"', "id=[a]"])("reads %s as the id a", (written) => {
    expect(attributes([`shell ${written}`])[0]?.id).toBe("a");
  });

  it.each([
    ["depends=a", ["a"]],
    ['depends="a, c"', ["a", "c"]],
  ])("reads %s as a list of cells", (written, depends) => {
    const cells = attributes(["shell id=a", "shell id=c", `shell id=b ${written}`]);

    expect(cells[2]?.depends).toEqual(depends);
  });

  it("takes the last of a repeated attribute", () => {
    expect(attributes(["shell id=a timeout=5 timeout=7"])[0]?.timeout).toBe(7);
  });

  it("takes maxTokens when max_tokens is there too", () => {
    expect(attributes(["ai id=a max_tokens=9 maxTokens=5"])[0]?.maxTokens).toBe(5);
    expect(attributes(["ai id=a max_tokens=9"])[0]?.maxTokens).toBe(9);
  });

  it.each(["py", "go"])("checks the timeout of an ore:%s cell", (type) => {
    expect(() => attributes([`${type} id=a timeout=abc`])).toThrow(
      'Cell a has an invalid timeout "abc": expected a number of seconds greater than 0 and at most 86400'
    );
    expect(attributes([`${type} id=a timeout=30`])[0]?.timeout).toBe(30);
  });
});
