/**
 * @vaultore/core - Output notes
 *
 * Renders the Markdown views the executor writes next to each cell's JSON
 * record: the per-cell output view and the per-cell artifact index.
 */

import type { OutputMeta } from "../types";

export interface ArtifactIndexInput {
  cellId: string;
  runId: string;
  workflowPath: string;
  timestamp: string;
  artifactDir: string;
  files?: string[];
}

export function renderArtifactIndex(input: ArtifactIndexInput): string {
  // Frontmatter follows the Open Knowledge Format (OKF) v0.1: `type` is the
  // one required field, so artifact indexes are valid OKF concepts and any
  // OKF consumer can ingest the output tree as a knowledge bundle.
  const lines: string[] = [
    "---",
    "type: VaultOre Artifacts",
    `title: Artifacts for ${input.cellId}`,
    `description: Files produced by cell ${input.cellId} of ${input.workflowPath}.`,
    `timestamp: ${input.timestamp}`,
    "tags: [vaultore, artifacts]",
    "vaultore: artifacts",
    `runId: ${input.runId}`,
    `cellId: ${input.cellId}`,
    `workflowPath: ${input.workflowPath}`,
    `artifactDir: ${input.artifactDir}`,
    "---",
    "",
    "# Artifacts",
  ];

  if (input.files?.length) {
    for (const file of input.files) {
      lines.push(`- [[${file}]]`);
    }
  } else {
    lines.push("- (No files listed)");
  }

  return lines.join("\n");
}

export function renderOutputMarkdown(
  cellId: string,
  meta: OutputMeta,
  value: unknown,
  outputPath: string
): string {
  // Frontmatter follows the Open Knowledge Format (OKF) v0.1: `type` is the
  // one required field; title/description/timestamp are OKF-recommended.
  // Extra keys are allowed — OKF consumers preserve unknown fields.
  const frontmatter: string[] = [
    "---",
    "type: VaultOre Output",
    `title: ${cellId} output`,
    `description: Output of workflow cell ${cellId} (status ${meta.status}).`,
    `timestamp: ${meta.timestamp}`,
    "tags: [vaultore, output]",
    "vaultore: output",
    `cellId: ${cellId}`,
    `runId: ${meta.runId ?? ""}`,
    `status: ${meta.status}`,
    `durationMs: ${meta.duration}`,
    `source: ${outputPath}`,
  ];

  if (meta.artifacts?.artifactDir) {
    frontmatter.push(`artifactDir: ${meta.artifacts.artifactDir}`);
  }
  if (meta.artifacts?.files?.length) {
    frontmatter.push("files:");
    for (const file of meta.artifacts.files) {
      frontmatter.push(`  - ${file}`);
    }
  }

  frontmatter.push("---");

  const payload =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const lang = typeof value === "string" ? "text" : "json";

  return `${frontmatter.join("\n")}\n\n\`\`\`${lang}\n${payload}\n\`\`\`\n`;
}
