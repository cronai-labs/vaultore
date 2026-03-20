/**
 * @vaultore/core - Workflow Parser
 *
 * BRICK-002: Parses workflow notes into structured data
 *
 * Responsibilities:
 * - Extract and validate frontmatter
 * - Parse ore:* code blocks into Cell objects
 * - Extract existing outputs from HTML comments
 * - Reconstruct workflow from parts
 */

import { parse as parseYaml } from "yaml";
import {
  Workflow,
  WorkflowFrontmatter,
  WorkflowFrontmatterSchema,
  Cell,
  CellType,
  CellAttributes,
  CellOutput,
  OutputMeta,
} from "../types";

// =============================================================================
// CONSTANTS
// =============================================================================

const FRONTMATTER_REGEX = /^---\n([\s\S]*?)\n---/;
const CELL_REGEX = /```ore:(ts|shell|ai|py|go)\s*([^\n]*)\n([\s\S]*?)```/g;
const OUTPUT_REGEX = /<!--\s*ore:output:(\S+)\n([\s\S]*?)-->/g;
const CELL_ATTR_REGEX = /(\w+)=(?:"([^"]*)"|'([^']*)'|\[([^\]]*)\]|(\S+))/g;

// =============================================================================
// PARSER CLASS
// =============================================================================

export class WorkflowParser {
  /**
   * Parse a complete workflow from markdown content
   */
  parse(content: string, path: string): Workflow {
    const frontmatter = this.parseFrontmatter(content);
    const cells = this.parseCells(content);
    const outputs = this.parseOutputs(content);

    return {
      path,
      frontmatter,
      cells,
      outputs,
      rawContent: content,
    };
  }

  /**
   * Check if content is a valid workflow
   */
  isWorkflow(content: string): boolean {
    const match = content.match(FRONTMATTER_REGEX);
    if (!match) return false;

    try {
      const yaml = parseYaml(match[1]);
      return yaml?.ore === true;
    } catch {
      return false;
    }
  }

  /**
   * Parse and validate frontmatter
   */
  parseFrontmatter(content: string): WorkflowFrontmatter {
    const match = content.match(FRONTMATTER_REGEX);
    if (!match) {
      throw new ParserError("No frontmatter found", 0);
    }

    let yaml: unknown;
    try {
      yaml = parseYaml(match[1]);
    } catch (e) {
      throw new ParserError(`Invalid YAML: ${e}`, 0);
    }

    const result = WorkflowFrontmatterSchema.safeParse(yaml);
    if (!result.success) {
      const issues = result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join(", ");
      throw new ParserError(`Invalid frontmatter: ${issues}`, 0);
    }

    return result.data as WorkflowFrontmatter;
  }

  /**
   * Parse all ore:* code blocks into Cell objects
   */
  parseCells(content: string): Cell[] {
    const cells: Cell[] = [];

    let match: RegExpExecArray | null;
    CELL_REGEX.lastIndex = 0;

    while ((match = CELL_REGEX.exec(content)) !== null) {
      const [rawBlock, typeStr, attrString, cellContent] = match;
      const type = typeStr as CellType;

      const beforeMatch = content.slice(0, match.index);
      const startLine = beforeMatch.split("\n").length;
      const endLine = startLine + rawBlock.split("\n").length - 1;

      const attributes = this.parseAttributes(attrString, type, startLine);

      cells.push({
        attributes,
        content: cellContent.trim(),
        startLine,
        endLine,
        rawBlock,
      });
    }

    // Validate unique IDs
    const ids = new Set<string>();
    for (const cell of cells) {
      if (ids.has(cell.attributes.id)) {
        throw new ParserError(`Duplicate cell ID: ${cell.attributes.id}`, cell.startLine);
      }
      ids.add(cell.attributes.id);
    }

    // Validate dependencies
    for (const cell of cells) {
      for (const dep of cell.attributes.depends ?? []) {
        if (!ids.has(dep)) {
          throw new ParserError(
            `Cell ${cell.attributes.id} depends on unknown cell: ${dep}`,
            cell.startLine
          );
        }
      }
    }

    return cells;
  }

  /**
   * Parse cell attributes
   */
  private parseAttributes(
    attrString: string,
    type: CellType,
    line: number
  ): CellAttributes {
    const attrs: Record<string, string> = {};

    let match: RegExpExecArray | null;
    CELL_ATTR_REGEX.lastIndex = 0;

    while ((match = CELL_ATTR_REGEX.exec(attrString)) !== null) {
      const [, key, doubleQuoted, singleQuoted, bracketed, unquoted] = match;
      attrs[key] = doubleQuoted ?? singleQuoted ?? bracketed ?? unquoted;
    }

    if (!attrs.id) {
      throw new ParserError(`Cell at line ${line} missing 'id' attribute`, line);
    }

    // Parse depends array
    let depends: string[] | undefined;
    if (attrs.depends) {
      const depsStr = attrs.depends.replace(/^\[|\]$/g, "");
      depends = depsStr
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
    }

    const temperature = attrs.temperature ? parseFloat(attrs.temperature) : undefined;
    const maxTokensRaw = attrs.maxTokens ?? attrs.max_tokens;
    const maxTokens = maxTokensRaw ? parseInt(maxTokensRaw, 10) : undefined;

    return {
      id: attrs.id,
      type,
      depends,
      timeout: attrs.timeout ? parseInt(attrs.timeout, 10) : undefined,
      model: attrs.model,
      temperature: Number.isFinite(temperature) ? temperature : undefined,
      maxTokens: Number.isFinite(maxTokens) ? maxTokens : undefined,
      mode: attrs.mode as "tool" | "module" | undefined,
      stdin: attrs.stdin,
      stdout: attrs.stdout as "text" | "json" | "jsonl" | undefined,
    };
  }

  /**
   * Parse existing outputs from HTML comments
   */
  parseOutputs(content: string): Map<string, CellOutput> {
    const outputs = new Map<string, CellOutput>();

    let match: RegExpExecArray | null;
    OUTPUT_REGEX.lastIndex = 0;

    while ((match = OUTPUT_REGEX.exec(content)) !== null) {
      const [, cellId, outputContent] = match;

      try {
        const parsed = this.parseOutputContent(outputContent);
        outputs.set(cellId, {
          cellId,
          value: parsed.value,
          meta: parsed.meta,
        });
      } catch (e) {
        console.warn(`Failed to parse output for cell ${cellId}:`, e);
      }
    }

    return outputs;
  }

  /**
   * Parse ore-output callout stubs to locate persisted output files.
   */
  parseOutputStubs(content: string): Map<string, { outputPath?: string; runId?: string }> {
    const stubs = new Map<string, { outputPath?: string; runId?: string }>();
    const lines = content.split("\n");

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (!line.startsWith("> [!ore-output]")) continue;

      const cellId = line.replace("> [!ore-output]", "").trim();
      if (!cellId) continue;

      let outputPath: string | undefined;
      let runId: string | undefined;

      for (let j = i + 1; j < lines.length; j += 1) {
        const nextLine = lines[j];
        if (!nextLine.startsWith(">")) break;

        const trimmed = nextLine.replace(/^>\s*/, "");
        if (trimmed.startsWith("json:")) {
          const match = trimmed.match(/\[\[([^\]]+)\]\]/);
          if (match?.[1]) {
            outputPath = match[1].split("|")[0]?.trim();
          }
        } else if (trimmed.startsWith("run:")) {
          runId = trimmed.replace("run:", "").trim();
        }
      }

      stubs.set(cellId, { outputPath, runId });
    }

    return stubs;
  }

  private parseOutputContent(content: string): {
    value: unknown;
    meta: OutputMeta;
  } {
    const metaMatch = content.match(/\nmeta:\n([\s\S]*)$/);

    let valueStr: string;
    let metaStr: string | undefined;

    if (metaMatch) {
      valueStr = content.slice(0, metaMatch.index).trim();
      metaStr = metaMatch[1];
    } else {
      valueStr = content.trim();
    }

    let value: unknown;
    try {
      value = JSON.parse(valueStr);
    } catch {
      value = valueStr;
    }

    let meta: OutputMeta;
    if (metaStr) {
      const metaYaml = parseYaml(metaStr);
      meta = {
        status: metaYaml.status ?? "success",
        duration: parseDuration(metaYaml.duration),
        timestamp: metaYaml.timestamp ?? new Date().toISOString(),
        error: metaYaml.error,
        cache: metaYaml.cache,
      };
    } else {
      meta = {
        status: "success",
        duration: 0,
        timestamp: new Date().toISOString(),
      };
    }

    return { value, meta };
  }
}

// =============================================================================
// OUTPUT SERIALIZER
// =============================================================================

export class OutputSerializer {
  serialize(output: CellOutput): string {
    const lines: string[] = [];
    lines.push(`> [!ore-output] ${output.cellId}`);

    let viewPath: string | undefined;
    if (output.meta.outputViewPath) {
      viewPath = output.meta.outputViewPath;
    } else if (output.meta.outputPath) {
      viewPath = output.meta.outputPath.replace(/\.json$/i, ".md");
    }

    if (viewPath) {
      lines.push(`> view: [[${viewPath}]]`);
      lines.push(`> ![[${viewPath}]]`);
    }

    if (output.meta.outputPath) {
      lines.push(`> json: [[${output.meta.outputPath}]]`);
    }

    if (output.meta.runId) {
      lines.push(`> run: ${output.meta.runId}`);
    }

    lines.push(
      `> status: ${output.meta.status} | duration: ${formatDuration(
        output.meta.duration
      )} | at: ${output.meta.timestamp}`
    );

    if (output.meta.error) {
      const errorLines = output.meta.error.split(/\r?\n/);
      errorLines.forEach((line, idx) => {
        const prefix = idx === 0 ? "> error: " : "> ";
        lines.push(`${prefix}${line}`);
      });
    }

    const artifacts = output.meta.artifacts ?? extractArtifactsFromValue(output.value);
    if (artifacts?.artifactDir) {
      const dir = artifacts.artifactDir.replace(/\/+$/, "");
      lines.push(`> artifactDir: [[${dir}/_index.md]]`);
    }
    if (artifacts?.files?.length) {
      const links = artifacts.files.map((file) => `[[${file}]]`).join(", ");
      lines.push(`> artifacts: ${links}`);
    }

    return lines.join("\n");
  }

  updateWorkflowOutput(content: string, output: CellOutput): string {
    const outputComment = this.serialize(output);

    const existingRegex = new RegExp(
      `\\n*<!--\\s*ore:output:${escapeRegex(output.cellId)}\\n[\\s\\S]*?-->\\n*`,
      "g"
    );

    const stubRegex = new RegExp(
      `\\n*\\s*> \\[!ore-output\\]\\s*${escapeRegex(output.cellId)}\\n(?:>.*\\n?)*\\n*`,
      "g"
    );

    let nextContent = content.replace(existingRegex, "");
    nextContent = nextContent.replace(stubRegex, "");

    const cellRegex = new RegExp(
      `(\`\`\`ore:(?:ts|shell|ai|py|go)[^\\n]*id=["']?${escapeRegex(output.cellId)}["']?[^\\n]*\\n[\\s\\S]*?\`\`\`)(?:\\n[ \\t]*)*`,
      "g"
    );

    const match = cellRegex.exec(nextContent);
    if (match) {
      const blockEnd = match.index + match[1].length;
      const restStart = match.index + match[0].length;
      const before = nextContent.slice(0, blockEnd);
      const after = nextContent.slice(restStart).replace(/^\n+/, "\n");
      const separator = after.startsWith("\n") ? "" : "\n";
      return `${before}\n\n${outputComment}${separator}${after}`;
    }

    return nextContent.replace(/\n*$/, "") + "\n\n" + outputComment + "\n";
  }
}

// =============================================================================
// TEMPLATE INTERPOLATION
// =============================================================================

export class TemplateInterpolator {
  interpolate(content: string, outputs: Map<string, CellOutput>): string {
    return content.replace(/\{\{([\w-]+)\}\}/g, (match, cellId) => {
      const output = outputs.get(cellId);
      if (!output) return match;
      return typeof output.value === "string"
        ? output.value
        : JSON.stringify(output.value, null, 2);
    });
  }

  async interpolateAsync(
    content: string,
    outputs: Map<string, CellOutput>,
    readNote: (path: string) => Promise<string>
  ): Promise<string> {
    let result = this.interpolate(content, outputs);

    const noteRefRegex = /\{\{note:([^}]+)\}\}/g;
    const matches = [...result.matchAll(noteRefRegex)];

    for (const match of matches) {
      const [fullMatch, notePath] = match;
      try {
        const noteContent = await readNote(notePath);
        result = result.replace(fullMatch, noteContent);
      } catch {
        // Keep original if note not found
      }
    }

    return result;
  }
}

// =============================================================================
// ERRORS & HELPERS
// =============================================================================

export class ParserError extends Error {
  constructor(message: string, public readonly line: number) {
    super(`Parse error at line ${line}: ${message}`);
    this.name = "ParserError";
  }
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseDuration(str: string | number | undefined): number {
  if (typeof str === "number") return str;
  if (!str) return 0;

  const match = str.match(/^([\d.]+)(ms|s|m)?$/);
  if (!match) return 0;

  const value = parseFloat(match[1]);
  const unit = match[2] ?? "ms";

  switch (unit) {
    case "s":
      return value * 1000;
    case "m":
      return value * 60 * 1000;
    default:
      return value;
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function extractArtifactsFromValue(
  value: unknown
):
  | { artifactDir?: string; files?: string[] }
  | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const artifactDir =
    typeof record.artifactDir === "string" ? record.artifactDir : undefined;
  const files = Array.isArray(record.files)
    ? record.files.filter((file) => typeof file === "string")
    : undefined;
  if (!artifactDir && !files?.length) return undefined;
  return { artifactDir, files };
}

// =============================================================================
// EXPORTS
// =============================================================================

export const parser = new WorkflowParser();
export const serializer = new OutputSerializer();
export const interpolator = new TemplateInterpolator();
