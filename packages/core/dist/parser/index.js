'use strict';

var yaml = require('yaml');
var zod = require('zod');

// src/parser/index.ts
var WorkflowFrontmatterSchema = zod.z.object({
  ore: zod.z.literal(true),
  name: zod.z.string(),
  version: zod.z.string().optional(),
  author: zod.z.string().optional(),
  tags: zod.z.array(zod.z.string()).optional(),
  description: zod.z.string().optional(),
  runtime: zod.z.object({
    engine: zod.z.enum(["docker", "podman", "colima"]).optional(),
    image: zod.z.string().optional(),
    timeout: zod.z.number().optional(),
    memoryLimit: zod.z.string().optional(),
    cpuLimit: zod.z.number().optional()
  }).optional(),
  permissions: zod.z.object({
    network: zod.z.enum(["allow", "deny", "ask"]).optional(),
    buildNetwork: zod.z.enum(["allow", "deny", "ask"]).optional(),
    vaultWrite: zod.z.enum(["allow", "deny", "ask"]).optional(),
    vaultRead: zod.z.enum(["allow", "deny", "ask"]).optional()
  }).optional(),
  schedule: zod.z.string().optional(),
  go: zod.z.object({
    version: zod.z.string().optional(),
    builderImage: zod.z.string().optional(),
    cgo: zod.z.union([zod.z.literal(0), zod.z.literal(1)]).optional(),
    tags: zod.z.string().optional(),
    ldflags: zod.z.string().optional(),
    cache: zod.z.object({
      enabled: zod.z.boolean().optional(),
      dir: zod.z.string().optional()
    }).optional()
  }).optional()
});

// src/parser/index.ts
var FRONTMATTER_REGEX = /^---\n([\s\S]*?)\n---/;
var CELL_REGEX = /```ore:(ts|shell|ai|py|go)\s*([^\n]*)\n([\s\S]*?)```/g;
var OUTPUT_REGEX = /<!--\s*ore:output:(\S+)\n([\s\S]*?)-->/g;
var CELL_ATTR_REGEX = /(\w+)=(?:"([^"]*)"|'([^']*)'|\[([^\]]*)\]|(\S+))/g;
var WorkflowParser = class {
  /**
   * Parse a complete workflow from markdown content
   */
  parse(content, path) {
    const frontmatter = this.parseFrontmatter(content);
    const cells = this.parseCells(content);
    const outputs = this.parseOutputs(content);
    return {
      path,
      frontmatter,
      cells,
      outputs,
      rawContent: content
    };
  }
  /**
   * Check if content is a valid workflow
   */
  isWorkflow(content) {
    const match = content.match(FRONTMATTER_REGEX);
    if (!match) return false;
    try {
      const yaml$1 = yaml.parse(match[1]);
      return yaml$1?.ore === true;
    } catch {
      return false;
    }
  }
  /**
   * Parse and validate frontmatter
   */
  parseFrontmatter(content) {
    const match = content.match(FRONTMATTER_REGEX);
    if (!match) {
      throw new ParserError("No frontmatter found", 0);
    }
    let yaml$1;
    try {
      yaml$1 = yaml.parse(match[1]);
    } catch (e) {
      throw new ParserError(`Invalid YAML: ${e}`, 0);
    }
    const result = WorkflowFrontmatterSchema.safeParse(yaml$1);
    if (!result.success) {
      const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ");
      throw new ParserError(`Invalid frontmatter: ${issues}`, 0);
    }
    return result.data;
  }
  /**
   * Parse all ore:* code blocks into Cell objects
   */
  parseCells(content) {
    const cells = [];
    let match;
    CELL_REGEX.lastIndex = 0;
    while ((match = CELL_REGEX.exec(content)) !== null) {
      const [rawBlock, typeStr, attrString, cellContent] = match;
      const type = typeStr;
      const beforeMatch = content.slice(0, match.index);
      const startLine = beforeMatch.split("\n").length;
      const endLine = startLine + rawBlock.split("\n").length - 1;
      const attributes = this.parseAttributes(attrString, type, startLine);
      cells.push({
        attributes,
        content: cellContent.trim(),
        startLine,
        endLine,
        rawBlock
      });
    }
    const ids = /* @__PURE__ */ new Set();
    for (const cell of cells) {
      if (ids.has(cell.attributes.id)) {
        throw new ParserError(`Duplicate cell ID: ${cell.attributes.id}`, cell.startLine);
      }
      ids.add(cell.attributes.id);
    }
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
  parseAttributes(attrString, type, line) {
    const attrs = {};
    let match;
    CELL_ATTR_REGEX.lastIndex = 0;
    while ((match = CELL_ATTR_REGEX.exec(attrString)) !== null) {
      const [, key, doubleQuoted, singleQuoted, bracketed, unquoted] = match;
      attrs[key] = doubleQuoted ?? singleQuoted ?? bracketed ?? unquoted;
    }
    if (!attrs.id) {
      throw new ParserError(`Cell at line ${line} missing 'id' attribute`, line);
    }
    let depends;
    if (attrs.depends) {
      const depsStr = attrs.depends.replace(/^\[|\]$/g, "");
      depends = depsStr.split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    }
    const temperature = attrs.temperature ? parseFloat(attrs.temperature) : void 0;
    const maxTokensRaw = attrs.maxTokens ?? attrs.max_tokens;
    const maxTokens = maxTokensRaw ? parseInt(maxTokensRaw, 10) : void 0;
    return {
      id: attrs.id,
      type,
      depends,
      timeout: attrs.timeout ? parseInt(attrs.timeout, 10) : void 0,
      model: attrs.model,
      temperature: Number.isFinite(temperature) ? temperature : void 0,
      maxTokens: Number.isFinite(maxTokens) ? maxTokens : void 0,
      mode: attrs.mode,
      stdin: attrs.stdin,
      stdout: attrs.stdout
    };
  }
  /**
   * Parse existing outputs from HTML comments
   */
  parseOutputs(content) {
    const outputs = /* @__PURE__ */ new Map();
    let match;
    OUTPUT_REGEX.lastIndex = 0;
    while ((match = OUTPUT_REGEX.exec(content)) !== null) {
      const [, cellId, outputContent] = match;
      try {
        const parsed = this.parseOutputContent(outputContent);
        outputs.set(cellId, {
          cellId,
          value: parsed.value,
          meta: parsed.meta
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
  parseOutputStubs(content) {
    const stubs = /* @__PURE__ */ new Map();
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (!line.startsWith("> [!ore-output]")) continue;
      const cellId = line.replace("> [!ore-output]", "").trim();
      if (!cellId) continue;
      let outputPath;
      let runId;
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
  parseOutputContent(content) {
    const metaMatch = content.match(/\nmeta:\n([\s\S]*)$/);
    let valueStr;
    let metaStr;
    if (metaMatch) {
      valueStr = content.slice(0, metaMatch.index).trim();
      metaStr = metaMatch[1];
    } else {
      valueStr = content.trim();
    }
    let value;
    try {
      value = JSON.parse(valueStr);
    } catch {
      value = valueStr;
    }
    let meta;
    if (metaStr) {
      const metaYaml = yaml.parse(metaStr);
      meta = {
        status: metaYaml.status ?? "success",
        duration: parseDuration(metaYaml.duration),
        timestamp: metaYaml.timestamp ?? (/* @__PURE__ */ new Date()).toISOString(),
        error: metaYaml.error,
        cache: metaYaml.cache
      };
    } else {
      meta = {
        status: "success",
        duration: 0,
        timestamp: (/* @__PURE__ */ new Date()).toISOString()
      };
    }
    return { value, meta };
  }
};
var OutputSerializer = class {
  serialize(output) {
    const lines = [];
    lines.push(`> [!ore-output] ${output.cellId}`);
    let viewPath;
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
  updateWorkflowOutput(content, output) {
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
      return `${before}

${outputComment}${separator}${after}`;
    }
    return nextContent.replace(/\n*$/, "") + "\n\n" + outputComment + "\n";
  }
};
var TemplateInterpolator = class {
  interpolate(content, outputs) {
    return content.replace(/\{\{([\w-]+)\}\}/g, (match, cellId) => {
      const output = outputs.get(cellId);
      if (!output) return match;
      return typeof output.value === "string" ? output.value : JSON.stringify(output.value, null, 2);
    });
  }
  async interpolateAsync(content, outputs, readNote) {
    let result = this.interpolate(content, outputs);
    const noteRefRegex = /\{\{note:([^}]+)\}\}/g;
    const matches = [...result.matchAll(noteRefRegex)];
    for (const match of matches) {
      const [fullMatch, notePath] = match;
      try {
        const noteContent = await readNote(notePath);
        result = result.replace(fullMatch, noteContent);
      } catch {
      }
    }
    return result;
  }
};
var ParserError = class extends Error {
  constructor(message, line) {
    super(`Parse error at line ${line}: ${message}`);
    this.line = line;
    this.name = "ParserError";
  }
};
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function parseDuration(str) {
  if (typeof str === "number") return str;
  if (!str) return 0;
  const match = str.match(/^([\d.]+)(ms|s|m)?$/);
  if (!match) return 0;
  const value = parseFloat(match[1]);
  const unit = match[2] ?? "ms";
  switch (unit) {
    case "s":
      return value * 1e3;
    case "m":
      return value * 60 * 1e3;
    default:
      return value;
  }
}
function formatDuration(ms) {
  if (ms < 1e3) return `${ms}ms`;
  return `${(ms / 1e3).toFixed(2)}s`;
}
function extractArtifactsFromValue(value) {
  if (!value || typeof value !== "object") return void 0;
  const record = value;
  const artifactDir = typeof record.artifactDir === "string" ? record.artifactDir : void 0;
  const files = Array.isArray(record.files) ? record.files.filter((file) => typeof file === "string") : void 0;
  if (!artifactDir && !files?.length) return void 0;
  return { artifactDir, files };
}
var parser = new WorkflowParser();
var serializer = new OutputSerializer();
var interpolator = new TemplateInterpolator();

exports.OutputSerializer = OutputSerializer;
exports.ParserError = ParserError;
exports.TemplateInterpolator = TemplateInterpolator;
exports.WorkflowParser = WorkflowParser;
exports.interpolator = interpolator;
exports.parser = parser;
exports.serializer = serializer;
//# sourceMappingURL=index.js.map
//# sourceMappingURL=index.js.map