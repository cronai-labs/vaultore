/**
 * @vaultore/core - Output notes
 *
 * Renders the Markdown views the executor writes next to each cell's JSON
 * record: the per-cell output view and the per-cell artifact index.
 */

import { stringify as stringifyYaml } from "yaml";
import type { OutputMeta } from "../types";
import { VERSION } from "../version";

// Both notes are Open Knowledge Format (OKF) v0.2 concepts
// (https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md),
// so any OKF consumer can ingest the output tree as a knowledge bundle:
// - `type` is the one required key; `title`, `description` and `tags` are
//   recommended.
// - `status` is OKF's document lifecycle (draft | stable | deprecated), so the
//   cell's run state goes to the domain key `cellStatus`. Absent `status`
//   means `stable`, which a finished output is.
// - Provenance is `generated: { by: vaultore/<version>, at }` (§5.2, §7);
//   v0.2 retires v0.1's `timestamp`. Nothing reads these notes back — the
//   executor and the parser read the JSON record — so `timestamp` is dropped
//   rather than kept as an alias.
// - Links are Markdown links (§6.1); unknown keys are preserved by consumers.

export interface ArtifactIndexInput {
  cellId: string;
  runId: string;
  workflowPath: string;
  timestamp: string;
  artifactDir: string;
  files?: string[];
}

export function renderArtifactIndex(input: ArtifactIndexInput): string {
  const frontmatter = renderFrontmatter({
    type: "VaultOre Artifacts",
    title: `Artifacts for ${input.cellId}`,
    description: `Files produced by cell ${input.cellId} of ${input.workflowPath}.`,
    tags: ["vaultore", "artifacts"],
    vaultore: "artifacts",
    runId: input.runId,
    cellId: input.cellId,
    workflowPath: input.workflowPath,
    artifactDir: input.artifactDir,
    generated: generated(input.timestamp),
  });

  const lines = ["# Artifacts"];
  if (input.files?.length) {
    for (const file of input.files) {
      const target = relativePath(input.artifactDir, file);
      const text = target.startsWith("./") ? target.slice(2) : target;
      lines.push(`- [${escapeLinkText(text)}](${encodeLinkPath(target)})`);
    }
  } else {
    lines.push("- (No files listed)");
  }

  return `${frontmatter}\n${lines.join("\n")}`;
}

export function renderOutputMarkdown(
  cellId: string,
  meta: OutputMeta,
  value: unknown,
  outputPath: string
): string {
  const frontmatter = renderFrontmatter({
    type: "VaultOre Output",
    title: `${cellId} output`,
    description: `Output of workflow cell ${cellId} (status ${meta.status}).`,
    tags: ["vaultore", "output"],
    vaultore: "output",
    cellId,
    runId: meta.runId,
    cellStatus: meta.status,
    durationMs: meta.duration,
    source: outputPath,
    artifactDir: meta.artifacts?.artifactDir,
    files: meta.artifacts?.files?.length ? meta.artifacts.files : undefined,
    generated: generated(meta.timestamp),
  });

  const payload =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const lang = typeof value === "string" ? "text" : "json";
  const fence = fenceFor(payload);

  return `${frontmatter}\n${fence}${lang}\n${payload}\n${fence}\n`;
}

/**
 * A YAML library writes the frontmatter: ids and paths come from the note and
 * the cell, and a `: `, `#`, quote or newline in one of them broke the
 * interpolated block (#27). Undefined keys are left out.
 */
function renderFrontmatter(fields: Record<string, unknown>): string {
  const present = Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined)
  );
  return `---\n${stringifyYaml(present, { lineWidth: 0 })}---\n`;
}

/** OKF actor `<producer>/<version>` and an ISO 8601 datetime with an offset. */
function generated(timestamp: string): { by: string; at: string } {
  const at = new Date(timestamp);
  if (Number.isNaN(at.getTime())) {
    throw new Error(
      `Cannot write output note: timestamp "${timestamp}" is not an ISO 8601 datetime`
    );
  }
  return { by: `vaultore/${VERSION}`, at: at.toISOString() };
}

/**
 * A fence must be longer than any backtick run inside it, or a payload holding
 * ``` closes the block early and the rest renders as note text (#27).
 */
function fenceFor(payload: string): string {
  let longest = 0;
  for (const run of payload.match(/`+/g) ?? []) {
    longest = Math.max(longest, run.length);
  }
  return "`".repeat(Math.max(3, longest + 1));
}

/**
 * Path from the index's directory to a vault-relative file. Relative links
 * resolve the same way in Obsidian and in a plain OKF consumer, whatever the
 * bundle root is taken to be.
 */
function relativePath(fromDir: string, target: string): string {
  const from = fromDir.split("/").filter(Boolean);
  const to = target.split("/").filter(Boolean);
  let common = 0;
  while (common < from.length && common < to.length - 1 && from[common] === to[common]) {
    common += 1;
  }
  const up = from.slice(common).map(() => "..");
  const rest = to.slice(common);
  return up.length ? [...up, ...rest].join("/") : ["."].concat(rest).join("/");
}

/** Percent-encode each segment so spaces, parentheses and `#` stay in the link. */
function encodeLinkPath(path: string): string {
  return path
    .split("/")
    .map((segment) =>
      segment === "." || segment === ".."
        ? segment
        : encodeURIComponent(segment).replace(/[()]/g, (c) =>
            `%${c.charCodeAt(0).toString(16).toUpperCase()}`
          )
    )
    .join("/");
}

function escapeLinkText(text: string): string {
  return text.replace(/[\\[\]]/g, (c) => `\\${c}`);
}
