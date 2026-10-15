import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { renderArtifactIndex, renderOutputMarkdown } from "./output-note";
import { VERSION } from "../version";
import type { OutputMeta } from "../types";

/**
 * Output views and artifact indexes are OKF v0.2 concepts (#77). These tests
 * read the notes the way a consumer does: split off the frontmatter, parse it
 * as YAML, and look at keys and values, not at the text.
 */

function split(note: string): { frontmatter: Record<string, unknown>; body: string } {
	const match = note.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
	if (!match) throw new Error(`No frontmatter block in:\n${note}`);
	return {
		frontmatter: parseYaml(match[1] as string) as Record<string, unknown>,
		body: match[2] as string,
	};
}

/** ISO 8601 datetime with an explicit offset (OKF v0.2 §5). */
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

const HOSTILE_ID = 'a: b # c "d" \'e\'';
const HOSTILE_PATH = "_vaultore/runs/x: y #z/run 1/a [b].json";

function meta(overrides: Partial<OutputMeta> = {}): OutputMeta {
	return {
		status: "error",
		duration: 12,
		timestamp: "2026-10-15T10:00:00.000Z",
		runId: "2026-10-15T10-00-00-000Z-abc123",
		...overrides,
	};
}

describe("renderOutputMarkdown", () => {
	it("writes run state as cellStatus and leaves the OKF status key alone", () => {
		const { frontmatter } = split(renderOutputMarkdown("a", meta(), 1, "out/a.json"));

		expect(frontmatter.type).toBe("VaultOre Output");
		expect(frontmatter.cellStatus).toBe("error");
		expect(frontmatter).not.toHaveProperty("status");
	});

	it("records provenance as generated {by, at} instead of timestamp", () => {
		const { frontmatter } = split(renderOutputMarkdown("a", meta(), 1, "out/a.json"));

		expect(frontmatter.generated).toEqual({
			by: `vaultore/${VERSION}`,
			at: "2026-10-15T10:00:00.000Z",
		});
		expect((frontmatter.generated as { at: string }).at).toMatch(ISO_WITH_OFFSET);
		expect(frontmatter).not.toHaveProperty("timestamp");
	});

	it("rejects a timestamp that is not a datetime instead of writing it", () => {
		expect(() =>
			renderOutputMarkdown("a", meta({ timestamp: "yesterday" }), 1, "out/a.json")
		).toThrow(/yesterday/);
	});

	it("round-trips a hostile cell id and paths through the frontmatter", () => {
		const note = renderOutputMarkdown(
			HOSTILE_ID,
			meta({
				runId: "run #1: x",
				artifacts: { artifactDir: "dir: #x", files: ["f: 1.json", "# g.md"] },
			}),
			"value",
			HOSTILE_PATH
		);
		const { frontmatter } = split(note);

		expect(frontmatter.cellId).toBe(HOSTILE_ID);
		expect(frontmatter.title).toBe(`${HOSTILE_ID} output`);
		expect(frontmatter.runId).toBe("run #1: x");
		expect(frontmatter.source).toBe(HOSTILE_PATH);
		expect(frontmatter.artifactDir).toBe("dir: #x");
		expect(frontmatter.files).toEqual(["f: 1.json", "# g.md"]);
		expect(frontmatter.tags).toEqual(["vaultore", "output"]);
		expect(frontmatter.durationMs).toBe(12);
	});

	it("keeps a newline in a cell id inside its value", () => {
		const { frontmatter } = split(renderOutputMarkdown("a\nb: c", meta(), 1, "out/a.json"));

		expect(frontmatter.cellId).toBe("a\nb: c");
		expect(frontmatter).not.toHaveProperty("b");
	});

	it("fences a payload with a longer backtick run than the payload holds", () => {
		const payload = "before\n```\ninside\n````\nafter";
		const { body } = split(renderOutputMarkdown("a", meta(), payload, "out/a.json"));

		const fence = body.match(/^\n(`+)text\n/)?.[1];
		expect(fence).toBe("`````");
		expect(body).toBe(`\n${fence}text\n${payload}\n${fence}\n`);
	});

	it("keeps the three-backtick fence for a payload without backticks", () => {
		const { body } = split(renderOutputMarkdown("a", meta(), { n: 1 }, "out/a.json"));

		expect(body).toBe('\n```json\n{\n  "n": 1\n}\n```\n');
	});
});

describe("renderArtifactIndex", () => {
	const input = {
		cellId: HOSTILE_ID,
		runId: "run-1",
		workflowPath: "Workflows/digest: #1.md",
		timestamp: "2026-10-15T10:00:00.000Z",
		artifactDir: "_vaultore/artifacts/run 1",
		files: [
			"_vaultore/artifacts/run 1/summary.json",
			"_vaultore/artifacts/run 1/sub/a (b).md",
			"_vaultore/other/x.txt",
		],
	};

	it("emits OKF v0.2 frontmatter that parses back to its inputs", () => {
		const { frontmatter } = split(renderArtifactIndex(input));

		expect(frontmatter.type).toBe("VaultOre Artifacts");
		expect(frontmatter.cellId).toBe(HOSTILE_ID);
		expect(frontmatter.workflowPath).toBe("Workflows/digest: #1.md");
		expect(frontmatter.artifactDir).toBe("_vaultore/artifacts/run 1");
		expect(frontmatter.runId).toBe("run-1");
		expect(frontmatter.tags).toEqual(["vaultore", "artifacts"]);
		expect(frontmatter.generated).toEqual({
			by: `vaultore/${VERSION}`,
			at: "2026-10-15T10:00:00.000Z",
		});
		expect(frontmatter).not.toHaveProperty("timestamp");
		expect(frontmatter).not.toHaveProperty("status");
	});

	it("lists files as Markdown links relative to the index, not wikilinks", () => {
		const { body } = split(renderArtifactIndex(input));

		expect(body).not.toContain("[[");
		expect(body).toContain("- [summary.json](./summary.json)");
		expect(body).toContain("- [sub/a (b).md](./sub/a%20%28b%29.md)");
		expect(body).toContain("- [../../other/x.txt](../../other/x.txt)");
	});

	it("escapes brackets in link text", () => {
		const { body } = split(
			renderArtifactIndex({ ...input, files: ["_vaultore/artifacts/run 1/[x].md"] })
		);

		expect(body).toContain("- [\\[x\\].md](./%5Bx%5D.md)");
	});
});
