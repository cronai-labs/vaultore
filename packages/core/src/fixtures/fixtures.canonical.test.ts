import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { WorkflowParser } from "../parser";

const fixtureDir = resolve(__dirname, "../../../../fixtures/canonical");

describe("Canonical fixtures", () => {
  const parser = new WorkflowParser();
  const files = readdirSync(fixtureDir).filter((name) => name.endsWith(".md"));

  for (const file of files) {
    it(`parses ${file}`, () => {
      const content = readFileSync(join(fixtureDir, file), "utf8");
      expect(parser.isWorkflow(content)).toBe(true);

      const workflow = parser.parse(content, `fixtures/canonical/${file}`);
      expect(workflow.cells.length).toBeGreaterThan(0);

      const ids = new Set(workflow.cells.map((cell) => cell.attributes.id));
      expect(ids.size).toBe(workflow.cells.length);
    });
  }
});
