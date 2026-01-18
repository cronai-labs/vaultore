import { z } from 'zod';
import { parse } from 'yaml';
import { spawn } from 'child_process';
import { existsSync, accessSync, constants } from 'fs';
import { join } from 'path';
import { parse as parse$1 } from '@babel/parser';
import cronParser from 'cron-parser';

// src/types/index.ts
var DEFAULT_PERMISSIONS = {
  network: "deny",
  buildNetwork: "ask",
  vaultWrite: "deny",
  vaultRead: "allow"
};
var DEFAULT_RUNTIME = {
  engine: "docker",
  image: "oven/bun:1-alpine",
  timeout: 60,
  memoryLimit: "512m",
  cpuLimit: 1
};
var DEFAULT_GO_CONFIG = {
  version: "1.23",
  builderImage: "ghcr.io/vaultore/go-builder:1.23",
  cgo: 0,
  tags: "",
  ldflags: "-s -w",
  cache: {
    enabled: true,
    dir: ".vaultore/cache/go"
  }
};
var WorkflowFrontmatterSchema = z.object({
  ore: z.literal(true),
  name: z.string(),
  version: z.string().optional(),
  author: z.string().optional(),
  tags: z.array(z.string()).optional(),
  description: z.string().optional(),
  runtime: z.object({
    engine: z.enum(["docker", "podman", "colima"]).optional(),
    image: z.string().optional(),
    timeout: z.number().optional(),
    memoryLimit: z.string().optional(),
    cpuLimit: z.number().optional()
  }).optional(),
  permissions: z.object({
    network: z.enum(["allow", "deny", "ask"]).optional(),
    buildNetwork: z.enum(["allow", "deny", "ask"]).optional(),
    vaultWrite: z.enum(["allow", "deny", "ask"]).optional(),
    vaultRead: z.enum(["allow", "deny", "ask"]).optional()
  }).optional(),
  schedule: z.string().optional(),
  go: z.object({
    version: z.string().optional(),
    builderImage: z.string().optional(),
    cgo: z.union([z.literal(0), z.literal(1)]).optional(),
    tags: z.string().optional(),
    ldflags: z.string().optional(),
    cache: z.object({
      enabled: z.boolean().optional(),
      dir: z.string().optional()
    }).optional()
  }).optional()
});
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
      const yaml = parse(match[1]);
      return yaml?.ore === true;
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
    let yaml;
    try {
      yaml = parse(match[1]);
    } catch (e) {
      throw new ParserError(`Invalid YAML: ${e}`, 0);
    }
    const result = WorkflowFrontmatterSchema.safeParse(yaml);
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
      const metaYaml = parse(metaStr);
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
async function detectRuntimes() {
  const engines = ["docker", "podman", "colima"];
  const available = [];
  const errors = /* @__PURE__ */ new Map();
  for (const engine of engines) {
    try {
      await detectEngine(engine);
      available.push(engine);
    } catch (err) {
      errors.set(engine, err instanceof Error ? err.message : String(err));
    }
  }
  return {
    available,
    preferred: available[0] ?? null,
    errors
  };
}
async function detectEngine(engine) {
  if (engine === "colima") {
    await runCommand("colima", ["status"]);
    return;
  }
  await runCommand(engine, ["version"]);
}
async function execContainer(engine, options) {
  const start = Date.now();
  const { command, args } = buildRunCommand(engine, options);
  const result = await runCommand(command, args, options.stdin, options.timeout);
  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    duration: Date.now() - start
  };
}
function buildRunCommand(engine, options) {
  const runtime = engine === "colima" ? "docker" : engine;
  const args = ["run", "--rm"];
  if (!options.networkEnabled) {
    args.push("--network=none");
  }
  if (options.stdin) {
    args.push("-i");
  }
  if (options.memoryLimit) {
    args.push("--memory", options.memoryLimit);
  }
  if (options.cpuLimit) {
    args.push("--cpus", String(options.cpuLimit));
  }
  if (options.workdir) {
    args.push("--workdir", options.workdir);
  }
  if (options.env) {
    for (const [key, value] of Object.entries(options.env)) {
      args.push("-e", `${key}=${value}`);
    }
  }
  if (options.mounts) {
    for (const mount of options.mounts) {
      const mode = mount.readonly ? "ro" : "rw";
      args.push("-v", `${mount.source}:${mount.target}:${mode}`);
    }
  }
  args.push(options.image);
  args.push(...options.command);
  return { command: runtime, args };
}
function runCommand(command, args, stdin, timeoutMs = 0) {
  return new Promise((resolve, reject) => {
    const resolvedCommand = resolveCommandPath(command);
    const child = spawn(resolvedCommand, args, { stdio: "pipe" });
    let stdout = "";
    let stderr = "";
    let timeout;
    if (stdin) {
      child.stdin.write(stdin);
    }
    child.stdin.end();
    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });
    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });
    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        child.kill("SIGKILL");
      }, timeoutMs);
    }
    child.on("error", reject);
    child.on("close", (code) => {
      if (timeout) clearTimeout(timeout);
      resolve({
        exitCode: code ?? 1,
        stdout,
        stderr
      });
    });
  });
}
function resolveCommandPath(command) {
  if (command.includes("/") || command.includes("\\")) {
    return command;
  }
  const candidates = [];
  const pathEntries = (process.env.PATH ?? "").split(":").filter(Boolean);
  for (const entry of pathEntries) {
    candidates.push(join(entry, command));
  }
  for (const candidate of knownCommandPaths(command)) {
    candidates.push(candidate);
  }
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return command;
}
function knownCommandPaths(command) {
  const platform = process.platform;
  if (command === "docker") {
    if (platform === "darwin") {
      return [
        "/usr/local/bin/docker",
        "/opt/homebrew/bin/docker",
        "/Applications/Docker.app/Contents/Resources/bin/docker"
      ];
    }
    if (platform === "win32") {
      return [
        "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe",
        "C:\\Program Files (x86)\\Docker\\Docker\\resources\\bin\\docker.exe"
      ];
    }
    return ["/usr/bin/docker"];
  }
  if (command === "podman") {
    if (platform === "darwin") {
      return ["/usr/local/bin/podman", "/opt/homebrew/bin/podman"];
    }
    if (platform === "win32") {
      return ["C:\\Program Files\\RedHat\\Podman\\podman.exe"];
    }
    return ["/usr/bin/podman"];
  }
  if (command === "colima") {
    if (platform === "darwin") {
      return ["/usr/local/bin/colima", "/opt/homebrew/bin/colima"];
    }
    return [];
  }
  return [];
}

// src/providers/index.ts
async function createProviderFromSettings(platform, providerName) {
  switch (providerName) {
    case "anthropic":
      return createAnthropicProvider(platform);
    case "openai":
    default:
      return createOpenAIProvider(platform);
  }
}
function createOpenAIProvider(platform) {
  return {
    name: "openai",
    async complete(request) {
      const apiKey = await platform.getSecret("openai.apiKey");
      if (!apiKey) {
        throw new Error("Missing OpenAI API key");
      }
      const useMaxCompletionTokens = usesMaxCompletionTokens(request.model);
      const supportsTemperature = supportsTemperatureParam(request.model);
      const body = {
        model: request.model,
        messages: [{ role: "user", content: request.prompt }]
      };
      if (supportsTemperature && request.temperature !== void 0) {
        body.temperature = request.temperature;
      }
      if (request.maxTokens !== void 0) {
        if (useMaxCompletionTokens) {
          body.max_completion_tokens = request.maxTokens;
        } else {
          body.max_tokens = request.maxTokens;
        }
      }
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify(body)
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`OpenAI error: ${response.status} ${text}`);
      }
      const data = await response.json();
      const content = data.choices?.[0]?.message?.content ?? "";
      return {
        content,
        model: request.model,
        usage: data.usage ? {
          promptTokens: data.usage.prompt_tokens,
          completionTokens: data.usage.completion_tokens,
          totalTokens: data.usage.total_tokens
        } : void 0
      };
    }
  };
}
function usesMaxCompletionTokens(model) {
  const normalized = model.toLowerCase();
  return normalized.startsWith("o1") || normalized.startsWith("o3") || normalized.startsWith("gpt-5");
}
function supportsTemperatureParam(model) {
  const normalized = model.toLowerCase();
  if (normalized.startsWith("o1") || normalized.startsWith("o3")) return false;
  if (normalized.startsWith("gpt-5")) return false;
  return true;
}
function createAnthropicProvider(platform) {
  return {
    name: "anthropic",
    async complete(request) {
      const apiKey = await platform.getSecret("anthropic.apiKey");
      if (!apiKey) {
        throw new Error("Missing Anthropic API key");
      }
      const maxTokens = request.maxTokens ?? 800;
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify({
          model: request.model,
          max_tokens: maxTokens,
          ...request.temperature !== void 0 ? { temperature: request.temperature } : {},
          messages: [{ role: "user", content: request.prompt }]
        })
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Anthropic error: ${response.status} ${text}`);
      }
      const data = await response.json();
      const content = data.content?.[0]?.text ?? "";
      return {
        content,
        model: request.model,
        usage: data.usage ? {
          promptTokens: data.usage.input_tokens,
          completionTokens: data.usage.output_tokens,
          totalTokens: data.usage.input_tokens + data.usage.output_tokens
        } : void 0
      };
    }
  };
}
var WorkflowExecutor = class {
  parser = new WorkflowParser();
  serializer = new OutputSerializer();
  interpolator = new TemplateInterpolator();
  async runWorkflow(options) {
    const workflow = this.parser.parse(options.content, options.workflowPath);
    const runContext = await createRunContext(options.platform, workflow.path);
    const permissions = await resolvePermissions(
      options.platform,
      workflow.path,
      workflow.frontmatter
    );
    const runtimeEngine = workflow.frontmatter.runtime?.engine ?? options.platform.getSetting("vaultore.runtimeEngine") ?? DEFAULT_RUNTIME.engine;
    const runtime = {
      ...DEFAULT_RUNTIME,
      ...workflow.frontmatter.runtime,
      engine: runtimeEngine
    };
    await ensureRuntimeAvailable(runtime.engine);
    const orderedCells = orderCells(workflow.cells);
    const cellsToRun = options.targetCellId ? filterCellsForTarget(
      orderedCells,
      options.targetCellId,
      !options.skipDependencies
    ) : orderedCells;
    const outputs = new Map(workflow.outputs);
    await hydrateOutputsFromStubs(this.parser, options.platform, workflow.rawContent, outputs);
    let updatedContent = workflow.rawContent;
    for (const cell of cellsToRun) {
      options.emitEvent?.("cell:started", { cellId: cell.attributes.id });
      const result = await this.runCell({
        cell,
        platform: options.platform,
        permissions,
        outputs,
        runtime,
        runContext
      });
      const outputPath = await persistCellOutput(
        options.platform,
        runContext,
        workflow.path,
        result
      );
      result.meta.runId = runContext.runId;
      result.meta.outputPath = outputPath;
      outputs.set(cell.attributes.id, result);
      updatedContent = this.serializer.updateWorkflowOutput(updatedContent, result);
      await options.platform.writeFile(workflow.path, updatedContent);
      options.emitEvent?.("cell:completed", { cellId: cell.attributes.id });
    }
    return {
      ...workflow,
      outputs,
      rawContent: updatedContent
    };
  }
  async runCell(params) {
    const { cell, platform, permissions, outputs, runtime, runContext } = params;
    const start = Date.now();
    try {
      const deps = cell.attributes.depends ?? [];
      for (const dep of deps) {
        const depOutput = outputs.get(dep);
        if (!depOutput) {
          return buildOutput(
            cell.attributes.id,
            `Dependency output missing: ${dep}`,
            start,
            "error"
          );
        }
        if (depOutput.meta.status !== "success") {
          return buildOutput(
            cell.attributes.id,
            `Dependency failed: ${dep}`,
            start,
            "error"
          );
        }
      }
      if (cell.attributes.type === "ts") {
        const value = await executeTypeScriptCell(
          cell,
          platform,
          permissions,
          outputs,
          runtime,
          runContext
        );
        return buildOutput(cell.attributes.id, value, start);
      }
      if (cell.attributes.type === "shell") {
        const value = await executeShellCell(
          cell,
          platform,
          permissions,
          runtime,
          runContext
        );
        return buildOutput(cell.attributes.id, value, start);
      }
      if (cell.attributes.type === "ai") {
        const value = await executeAICell(
          cell,
          platform,
          permissions,
          outputs,
          this.interpolator
        );
        return buildOutput(cell.attributes.id, value, start);
      }
      return buildOutput(
        cell.attributes.id,
        `Cell type not supported in v0.1: ${cell.attributes.type}`,
        start,
        "error"
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return buildOutput(cell.attributes.id, message, start, "error");
    }
  }
};
async function resolvePermissions(platform, workflowPath, frontmatter) {
  const merged = {
    ...DEFAULT_PERMISSIONS,
    ...frontmatter.permissions
  };
  const stored = platform.getSetting(
    "vaultore.permissionDecisions"
  ) ?? {};
  const current = stored[workflowPath];
  const resolved = { ...merged };
  for (const key of Object.keys(merged)) {
    if (merged[key] !== "ask") continue;
    if (current?.[key] && current[key] !== "ask") {
      resolved[key] = current[key];
      continue;
    }
    if (!platform.confirm) {
      resolved[key] = "deny";
      continue;
    }
    const approved = await platform.confirm(
      `VaultOre permission request: ${key} for ${workflowPath}. Allow?`
    );
    resolved[key] = approved ? "allow" : "deny";
  }
  stored[workflowPath] = resolved;
  await platform.setSetting("vaultore.permissionDecisions", stored);
  return {
    network: resolved.network === "allow",
    buildNetwork: resolved.buildNetwork === "allow",
    vaultRead: resolved.vaultRead === "allow",
    vaultWrite: resolved.vaultWrite === "allow"
  };
}
async function ensureRuntimeAvailable(engine) {
  const detection = await detectRuntimes();
  if (!detection.available.includes(engine)) {
    const error = detection.errors.get(engine) ?? "runtime not available";
    throw new Error(`Container runtime ${engine} not available: ${error}`);
  }
}
function orderCells(cells) {
  const byId = /* @__PURE__ */ new Map();
  const deps = /* @__PURE__ */ new Map();
  const dependents = /* @__PURE__ */ new Map();
  for (const cell of cells) {
    byId.set(cell.attributes.id, cell);
    deps.set(cell.attributes.id, new Set(cell.attributes.depends ?? []));
    dependents.set(cell.attributes.id, /* @__PURE__ */ new Set());
  }
  for (const cell of cells) {
    for (const dep of cell.attributes.depends ?? []) {
      dependents.get(dep)?.add(cell.attributes.id);
    }
  }
  const ready = Array.from(deps.entries()).filter(([, depsSet]) => depsSet.size === 0).map(([id]) => id);
  const ordered = [];
  while (ready.length > 0) {
    const id = ready.shift();
    if (!id) break;
    const cell = byId.get(id);
    if (cell) ordered.push(cell);
    for (const dep of dependents.get(id) ?? []) {
      const set = deps.get(dep);
      if (!set) continue;
      set.delete(id);
      if (set.size === 0) ready.push(dep);
    }
  }
  return ordered.length === cells.length ? ordered : cells;
}
function filterCellsForTarget(cells, targetId, includeDependencies = true) {
  if (!includeDependencies) {
    return cells.filter((cell) => cell.attributes.id === targetId);
  }
  const byId = new Map(cells.map((cell) => [cell.attributes.id, cell]));
  const result = [];
  const visited = /* @__PURE__ */ new Set();
  function visit(id) {
    if (visited.has(id)) return;
    visited.add(id);
    const cell = byId.get(id);
    if (!cell) return;
    for (const dep of cell.attributes.depends ?? []) {
      visit(dep);
    }
    result.push(cell);
  }
  visit(targetId);
  const orderedIds = new Set(result.map((cell) => cell.attributes.id));
  return cells.filter((cell) => orderedIds.has(cell.attributes.id));
}
function buildOutput(cellId, value, start, status = "success") {
  return {
    cellId,
    value,
    meta: {
      status,
      duration: Date.now() - start,
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      error: status === "error" ? String(value) : void 0
    }
  };
}
async function createRunContext(platform, workflowPath) {
  const startedAt = (/* @__PURE__ */ new Date()).toISOString();
  const runId = createRunId();
  const outputRootSetting = platform.getSetting("vaultore.outputRoot");
  const outputRoot = normalizeOutputRoot(outputRootSetting);
  const runBaseDir = runBasePath(outputRoot, workflowPath);
  const runDir = `${runBaseDir}/${runId}`;
  await platform.mkdirp(runDir);
  await platform.writeFile(
    `${runDir}/run.json`,
    JSON.stringify(
      {
        runId,
        workflowPath,
        startedAt,
        status: "running"
      },
      null,
      2
    )
  );
  return { runId, runDir, runBaseDir, startedAt, workflowPath, outputRoot };
}
async function hydrateOutputsFromStubs(parser2, platform, content, outputs) {
  const stubs = parser2.parseOutputStubs(content);
  for (const [cellId, stub] of stubs.entries()) {
    if (outputs.has(cellId)) continue;
    if (!stub.outputPath) continue;
    if (!await platform.exists(stub.outputPath)) continue;
    try {
      const raw = await platform.readFile(stub.outputPath);
      const record = JSON.parse(raw);
      if (!record?.meta || !record.cellId) continue;
      outputs.set(cellId, {
        cellId,
        value: record.value,
        meta: record.meta
      });
    } catch {
    }
  }
}
async function persistCellOutput(platform, runContext, workflowPath, output) {
  const outputPath = `${runContext.runDir}/${safeFileName(output.cellId)}.json`;
  const outputViewPath = outputPath.replace(/\.json$/i, ".md");
  const artifacts = extractArtifacts(output.value);
  output.meta.artifacts = artifacts;
  output.meta.outputViewPath = outputViewPath;
  if (artifacts?.artifactDir) {
    await ensureArtifactIndex(platform, runContext, output, artifacts);
  }
  const record = {
    runId: runContext.runId,
    workflowPath,
    cellId: output.cellId,
    value: output.value,
    meta: {
      ...output.meta,
      runId: runContext.runId,
      outputPath,
      outputViewPath
    }
  };
  await platform.writeFile(outputPath, JSON.stringify(record, null, 2));
  await platform.writeFile(
    outputViewPath,
    renderOutputMarkdown(output.cellId, record.meta, output.value, outputPath)
  );
  await updateRunIndex(platform, runContext, outputPath, outputViewPath, output);
  return outputPath;
}
async function updateRunIndex(platform, runContext, outputPath, outputViewPath, output) {
  const indexPath = `${runContext.runBaseDir}/index.json`;
  let index = { runs: [] };
  if (await platform.exists(indexPath)) {
    try {
      const raw = await platform.readFile(indexPath);
      const parsed = JSON.parse(raw);
      if (parsed?.runs) index = parsed;
    } catch {
    }
  }
  index.workflowPath = index.workflowPath ?? runContext.workflowPath;
  let runEntry = index.runs.find((run) => run.runId === runContext.runId);
  if (!runEntry) {
    runEntry = {
      runId: runContext.runId,
      startedAt: runContext.startedAt,
      status: "running",
      outputs: {}
    };
    index.runs.unshift(runEntry);
  }
  runEntry.outputs[output.cellId] = {
    outputPath,
    outputViewPath,
    status: output.meta.status,
    timestamp: output.meta.timestamp,
    ...output.meta.artifacts ? { artifacts: output.meta.artifacts } : {}
  };
  if (output.meta.status === "error") {
    runEntry.status = "error";
  } else if (runEntry.status !== "error") {
    runEntry.status = "success";
  }
  await platform.writeFile(indexPath, JSON.stringify(index, null, 2));
}
function createRunId() {
  const timestamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
  const rand = Math.random().toString(36).slice(2, 8);
  return `${timestamp}-${rand}`;
}
function runBasePath(outputRoot, workflowPath) {
  const normalized = workflowPath.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\.\./g, "").replace(/\.md$/i, "");
  return `${outputRoot}/runs/${normalized || "workflow"}`;
}
function safeFileName(name) {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}
function normalizeOutputRoot(value) {
  const fallback = "_vaultore";
  if (!value) return fallback;
  const normalized = value.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "").trim();
  return normalized || fallback;
}
function extractArtifacts(value) {
  if (!value || typeof value !== "object") return void 0;
  const record = value;
  const artifactDir = typeof record.artifactDir === "string" ? record.artifactDir : void 0;
  const files = Array.isArray(record.files) ? record.files.filter((file) => typeof file === "string") : void 0;
  if (!artifactDir && !files?.length) return void 0;
  return { artifactDir, files };
}
async function ensureArtifactIndex(platform, runContext, output, artifacts) {
  if (!artifacts.artifactDir) return;
  const dir = artifacts.artifactDir.replace(/\/+$/, "");
  const indexPath = `${dir}/_index.md`;
  await platform.mkdirp(dir);
  const lines = [
    "---",
    "vaultore: artifacts",
    `runId: ${runContext.runId}`,
    `cellId: ${output.cellId}`,
    `workflowPath: ${runContext.workflowPath}`,
    `created: ${output.meta.timestamp}`,
    `artifactDir: ${dir}`,
    "---",
    "",
    "# Artifacts"
  ];
  if (artifacts.files?.length) {
    for (const file of artifacts.files) {
      lines.push(`- [[${file}]]`);
    }
  } else {
    lines.push("- (No files listed)");
  }
  await platform.writeFile(indexPath, lines.join("\n"));
}
function extractVaultoreOutput(stdout) {
  const match = stdout.match(
    /__VAULTORE_OUTPUT_START__\s*([\s\S]*?)\s*__VAULTORE_OUTPUT_END__/
  );
  if (!match?.[1]) {
    return { found: false, payload: "" };
  }
  return { found: true, payload: match[1].trim() };
}
function renderOutputMarkdown(cellId, meta, value, outputPath) {
  const frontmatter = [
    "---",
    "vaultore: output",
    `cellId: ${cellId}`,
    `runId: ${meta.runId ?? ""}`,
    `status: ${meta.status}`,
    `timestamp: ${meta.timestamp}`,
    `durationMs: ${meta.duration}`,
    `source: ${outputPath}`
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
  const payload = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const lang = typeof value === "string" ? "text" : "json";
  return `${frontmatter.join("\n")}

\`\`\`${lang}
${payload}
\`\`\`
`;
}
async function executeTypeScriptCell(cell, platform, permissions, outputs, runtime, runContext) {
  const vaultRoot = await platform.getVaultRoot();
  const runtimeScript = buildTypeScriptRuntime(outputs, permissions, runContext);
  const { body, lastExpression } = extractLastExpression(cell.content);
  const script = `${runtimeScript}

const __vaultore_value = await (async () => {
${body}
return ${lastExpression};
})();
const __vaultore_payload = JSON.stringify(__vaultore_value);
console.log("__VAULTORE_OUTPUT_START__");
console.log(__vaultore_payload);
console.log("__VAULTORE_OUTPUT_END__");
`;
  const containerOpts = {
    image: runtime.image,
    command: ["sh", "-lc", "cat > /tmp/vaultore.ts && bun /tmp/vaultore.ts"],
    workdir: "/workspace",
    env: {
      VAULTORE_RUN_ID: runContext.runId,
      VAULTORE_OUTPUT_ROOT: runContext.outputRoot,
      VAULTORE_RUN_DIR: runContext.runDir
    },
    stdin: script,
    timeout: (cell.attributes.timeout ?? runtime.timeout) * 1e3,
    memoryLimit: runtime.memoryLimit,
    cpuLimit: runtime.cpuLimit,
    networkEnabled: permissions.network,
    mounts: [
      {
        source: vaultRoot,
        target: "/workspace",
        readonly: !permissions.vaultWrite
      }
    ]
  };
  const result = await execContainer(runtime.engine, containerOpts);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || `ts cell failed: exit ${result.exitCode}`);
  }
  const extracted = extractVaultoreOutput(result.stdout);
  if (extracted.found) {
    try {
      return JSON.parse(extracted.payload);
    } catch {
      return extracted.payload;
    }
  }
  try {
    return JSON.parse(result.stdout.trim());
  } catch {
    return result.stdout.trim();
  }
}
async function executeShellCell(cell, platform, permissions, runtime, runContext) {
  const vaultRoot = await platform.getVaultRoot();
  const image = "alpine:3.19";
  const command = ["sh", "-lc", cell.content];
  const containerOpts = {
    image,
    command,
    workdir: "/workspace",
    env: {
      VAULTORE_RUN_ID: runContext.runId,
      VAULTORE_OUTPUT_ROOT: runContext.outputRoot,
      VAULTORE_RUN_DIR: runContext.runDir
    },
    timeout: (cell.attributes.timeout ?? runtime.timeout) * 1e3,
    memoryLimit: runtime.memoryLimit,
    cpuLimit: runtime.cpuLimit,
    networkEnabled: permissions.network,
    mounts: [
      {
        source: vaultRoot,
        target: "/workspace",
        readonly: !permissions.vaultWrite
      }
    ]
  };
  const result = await execContainer(runtime.engine, containerOpts);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || `shell cell failed: exit ${result.exitCode}`);
  }
  return result.stdout;
}
async function executeAICell(cell, platform, permissions, outputs, interpolator2) {
  if (!permissions.network) {
    throw new Error("AI cells require network permission");
  }
  const model = cell.attributes.model ?? platform.getSetting("vaultore.defaultModel") ?? "gpt-4o-mini";
  const providerName = platform.getSetting("vaultore.defaultProvider") ?? "openai";
  const provider = await createProviderFromSettings(platform, providerName);
  const temperature = cell.attributes.temperature ?? platform.getSetting("vaultore.aiTemperature");
  const maxTokens = cell.attributes.maxTokens ?? platform.getSetting("vaultore.aiMaxTokens");
  const prompt = await interpolator2.interpolateAsync(
    cell.content,
    outputs,
    (path) => platform.readFile(path)
  );
  const response = await provider.complete({
    model,
    prompt,
    temperature,
    maxTokens
  });
  return response.content;
}
function buildTypeScriptRuntime(outputs, permissions, runContext) {
  const outputsJson = JSON.stringify(
    Object.fromEntries(
      Array.from(outputs.entries()).map(([id, output]) => [
        id,
        output.value
      ])
    )
  );
  const vaultRead = permissions.vaultRead ? "true" : "false";
  const vaultWrite = permissions.vaultWrite ? "true" : "false";
  const runId = JSON.stringify(runContext.runId);
  const outputRoot = JSON.stringify(runContext.outputRoot);
  const runDir = JSON.stringify(runContext.runDir);
  const workflowPath = JSON.stringify(runContext.workflowPath);
  return `
const __vaultore_outputs = ${outputsJson};
const vaultore = {
  runId: ${runId},
  outputRoot: ${outputRoot},
  runDir: ${runDir},
  workflowPath: ${workflowPath},
};
function cell(id) {
  if (!(id in __vaultore_outputs)) {
    throw new Error(\`Cell output not found: \${id}\`);
  }
  return __vaultore_outputs[id];
}

const __vaultore_permissions = { vaultRead: ${vaultRead}, vaultWrite: ${vaultWrite} };
const vault = {
  async read(path) {
    if (!__vaultore_permissions.vaultRead) {
      throw new Error("Vault read permission denied");
    }
    return await Bun.file("/workspace/" + path.replace(/^\\//, "")).text();
  },
  async write(path, content) {
    if (!__vaultore_permissions.vaultWrite) {
      throw new Error("Vault write permission denied");
    }
    await Bun.write("/workspace/" + path.replace(/^\\//, ""), content);
  },
  async exists(path) {
    if (!__vaultore_permissions.vaultRead) {
      throw new Error("Vault read permission denied");
    }
    return await Bun.file("/workspace/" + path.replace(/^\\//, "")).exists();
  },
  async mkdirp(path) {
    if (!__vaultore_permissions.vaultWrite) {
      throw new Error("Vault write permission denied");
    }
    const proc = Bun.spawn(["mkdir", "-p", "/workspace/" + path.replace(/^\\//, "")]);
    await proc.exited;
  },
  async readRaw(path) {
    return await Bun.file(path).text();
  },
};
`;
}
function extractLastExpression(code) {
  try {
    const ast = parse$1(code, {
      sourceType: "module",
      plugins: ["typescript", "topLevelAwait"],
      ranges: true
    });
    const bodyNodes = ast.program.body;
    let idx = bodyNodes.length - 1;
    while (idx >= 0) {
      const node = bodyNodes[idx];
      if (!node || node.type === "EmptyStatement") {
        idx -= 1;
        continue;
      }
      break;
    }
    if (idx < 0) {
      return { body: code, lastExpression: "undefined" };
    }
    const lastNode = bodyNodes[idx];
    if (lastNode.type === "ExpressionStatement") {
      const statementStart = lastNode.start ?? 0;
      const statementEnd = lastNode.end ?? code.length;
      const exprStart = lastNode.expression?.start ?? statementStart;
      const exprEnd = lastNode.expression?.end ?? statementEnd;
      const body = `${code.slice(0, statementStart)}${code.slice(statementEnd)}`.trimEnd();
      const lastExpression = code.slice(exprStart, exprEnd).trim();
      return {
        body,
        lastExpression: lastExpression || "undefined"
      };
    }
    return { body: code, lastExpression: "undefined" };
  } catch {
    return { body: code, lastExpression: "undefined" };
  }
}
var WorkflowScheduler = class {
  workflows = /* @__PURE__ */ new Map();
  interval = null;
  onTick;
  tickIntervalMs;
  constructor(options) {
    this.tickIntervalMs = options?.tickIntervalMs ?? 60 * 1e3;
    this.onTick = options?.onTick;
  }
  register(path, cronExpression) {
    const nextRun = computeNextRun(cronExpression);
    const entry = {
      path,
      cronExpression,
      nextRun,
      enabled: true
    };
    this.workflows.set(path, entry);
    return entry;
  }
  unregister(path) {
    this.workflows.delete(path);
  }
  list() {
    return Array.from(this.workflows.values());
  }
  start() {
    if (this.interval) return;
    this.interval = setInterval(() => this.tick(), this.tickIntervalMs);
  }
  stop() {
    if (!this.interval) return;
    clearInterval(this.interval);
    this.interval = null;
  }
  tick() {
    const now = /* @__PURE__ */ new Date();
    const due = [];
    for (const workflow of this.workflows.values()) {
      if (!workflow.enabled) continue;
      if (workflow.nextRun <= now) {
        due.push(workflow);
        workflow.lastRun = now;
        workflow.nextRun = computeNextRun(workflow.cronExpression, now);
      }
    }
    if (due.length > 0) {
      this.onTick?.(due);
    }
    return due;
  }
};
function computeNextRun(cronExpression, baseDate = /* @__PURE__ */ new Date()) {
  const interval = cronParser.parseExpression(cronExpression, { currentDate: baseDate });
  return interval.next().toDate();
}

// src/vault/index.ts
function createVaultAPI(platform, permissions) {
  return {
    async read(path) {
      if (!permissions.vaultRead) {
        throw new VaultError("Vault read permission denied");
      }
      const normalizedPath = normalizePath(path);
      return platform.readFile(normalizedPath);
    },
    async write(path, content) {
      if (!permissions.vaultWrite) {
        throw new VaultError("Vault write permission denied");
      }
      const normalizedPath = normalizePath(path);
      await platform.writeFile(normalizedPath, content);
    },
    async exists(path) {
      if (!permissions.vaultRead) {
        throw new VaultError("Vault read permission denied");
      }
      const normalizedPath = normalizePath(path);
      return platform.exists(normalizedPath);
    },
    async mkdirp(path) {
      if (!permissions.vaultWrite) {
        throw new VaultError("Vault write permission denied");
      }
      const normalizedPath = normalizePath(path);
      await platform.mkdirp(normalizedPath);
    },
    async readRaw(path) {
      if (!platform.readRaw) {
        throw new VaultError("readRaw not supported on this platform");
      }
      return platform.readRaw(path);
    }
  };
}
function createCellFn(outputs) {
  return (id) => {
    const output = outputs.get(id);
    if (!output) {
      throw new VaultError(`Cell output not found: ${id}`);
    }
    if (output.meta.status !== "success") {
      throw new VaultError(`Cell ${id} failed: ${output.meta.error}`);
    }
    return output.value;
  };
}
function normalizePath(path) {
  let normalized = path.startsWith("/") ? path.slice(1) : path;
  const parts = normalized.split("/").filter(Boolean);
  const resolved = [];
  for (const part of parts) {
    if (part === "..") {
      resolved.pop();
    } else if (part !== ".") {
      resolved.push(part);
    }
  }
  return resolved.join("/");
}
function generateRuntimeScript(cellOutputs, permissions = {}) {
  const outputsJson = JSON.stringify(
    Object.fromEntries(
      Array.from(cellOutputs.entries()).map(([id, output]) => [
        id,
        output.value
      ])
    )
  );
  const vaultRead = permissions.vaultRead ?? true;
  const vaultWrite = permissions.vaultWrite ?? false;
  return `
// VaultOre Runtime Injection
const __vaultore_outputs = ${outputsJson};
const __vaultore_permissions = { vaultRead: ${vaultRead}, vaultWrite: ${vaultWrite} };

function cell(id) {
  if (!(id in __vaultore_outputs)) {
    throw new Error(\`Cell output not found: \${id}\`);
  }
  return __vaultore_outputs[id];
}

const vault = {
  async read(path) {
    if (!__vaultore_permissions.vaultRead) {
      throw new Error("Vault read permission denied");
    }
    return await Bun.file("/workspace/" + path.replace(/^\\//, "")).text();
  },
  async write(path, content) {
    if (!__vaultore_permissions.vaultWrite) {
      throw new Error("Vault write permission denied");
    }
    await Bun.write("/workspace/" + path.replace(/^\\//, ""), content);
  },
  async exists(path) {
    if (!__vaultore_permissions.vaultRead) {
      throw new Error("Vault read permission denied");
    }
    return await Bun.file("/workspace/" + path.replace(/^\\//, "")).exists();
  },
  async mkdirp(path) {
    if (!__vaultore_permissions.vaultWrite) {
      throw new Error("Vault write permission denied");
    }
    const proc = Bun.spawn(["mkdir", "-p", "/workspace/" + path.replace(/^\\//, "")]);
    await proc.exited;
  },
  async readRaw(path) {
    return await Bun.file(path).text();
  },
};
`;
}
var VaultError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "VaultError";
  }
};

// src/index.ts
var VERSION = "0.1.0";

export { DEFAULT_GO_CONFIG, DEFAULT_PERMISSIONS, DEFAULT_RUNTIME, OutputSerializer, ParserError, TemplateInterpolator, VERSION, VaultError, WorkflowExecutor, WorkflowFrontmatterSchema, WorkflowParser, WorkflowScheduler, computeNextRun, createCellFn, createProviderFromSettings, createVaultAPI, detectRuntimes, execContainer, generateRuntimeScript, interpolator, parser, serializer };
//# sourceMappingURL=index.mjs.map
//# sourceMappingURL=index.mjs.map