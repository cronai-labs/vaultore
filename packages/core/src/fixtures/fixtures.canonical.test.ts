import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { WorkflowParser } from "../parser";

// The security fixtures (#341) follow the same rules: they run on whatever
// engine the user configured.
for (const folder of ["canonical", "security"]) {
  const fixtureDir = resolve(__dirname, "../../../../fixtures", folder);

  describe(`${folder} fixtures`, () => {
    const parser = new WorkflowParser();
    const files = readdirSync(fixtureDir).filter((name) => name.endsWith(".md"));

    for (const file of files) {
      it(`parses ${file}`, () => {
        const content = readFileSync(join(fixtureDir, file), "utf8");
        expect(parser.isWorkflow(content)).toBe(true);

        const workflow = parser.parse(content, `fixtures/${folder}/${file}`);
        expect(workflow.cells.length).toBeGreaterThan(0);

        const ids = new Set(workflow.cells.map((cell) => cell.attributes.id));
        expect(ids.size).toBe(workflow.cells.length);
      });

      // A fixture runs on whatever the user configured: a pinned engine
      // overrides the engine setting, and a pinned model fails under the other
      // provider before any request (#120).
      it(`pins neither an engine nor a model in ${file}`, () => {
        const workflow = parser.parse(
          readFileSync(join(fixtureDir, file), "utf8"),
          `fixtures/${folder}/${file}`
        );
        expect(workflow.frontmatter.runtime?.engine).toBeUndefined();
        for (const cell of workflow.cells) {
          expect(cell.attributes.model, `model of cell "${cell.attributes.id}"`).toBeUndefined();
        }
      });
    }
  });
}
