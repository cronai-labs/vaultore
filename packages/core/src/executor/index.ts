/**
 * @vaultore/core - Workflow Executor
 *
 * BRICK-004/005/006: Executes cells and persists outputs
 */

import {
  Cell,
  CellOutput,
  ContainerExecOptions,
  OutputMeta,
  PlatformAdapter,
  RuntimeEngine,
  Workflow,
  WorkflowFrontmatter,
  WorkflowPermissions,
  DEFAULT_PERMISSIONS,
  DEFAULT_RUNTIME,
} from "../types";
import { detectRuntimes, execContainer } from "../runtime";
import { OutputSerializer, TemplateInterpolator, WorkflowParser } from "../parser";
import { createProviderFromSettings } from "../providers";
import { parse } from "@babel/parser";

// =============================================================================
// EXECUTOR
// =============================================================================

export interface ExecuteOptions {
  platform: PlatformAdapter;
  workflowPath: string;
  content: string;
  targetCellId?: string;
  skipDependencies?: boolean;
  emitEvent?: (event: string, data?: unknown) => void;
}

export class WorkflowExecutor {
  private parser = new WorkflowParser();
  private serializer = new OutputSerializer();
  private interpolator = new TemplateInterpolator();

  async runWorkflow(options: ExecuteOptions): Promise<Workflow> {
    const workflow = this.parser.parse(options.content, options.workflowPath);
    const runContext = await createRunContext(options.platform, workflow.path);

    const permissions = await resolvePermissions(
      options.platform,
      workflow.path,
      workflow.frontmatter
    );

    const runtimeEngine =
      workflow.frontmatter.runtime?.engine ??
      options.platform.getSetting<string>("vaultore.runtimeEngine") ??
      DEFAULT_RUNTIME.engine;
    const runtime = {
      ...DEFAULT_RUNTIME,
      ...workflow.frontmatter.runtime,
      engine: runtimeEngine as RuntimeEngine,
    };

    await ensureRuntimeAvailable(runtime.engine);

    const orderedCells = orderCells(workflow.cells);
    const cellsToRun = options.targetCellId
      ? filterCellsForTarget(
          orderedCells,
          options.targetCellId,
          !options.skipDependencies
        )
      : orderedCells;
    const outputs = new Map<string, CellOutput>(workflow.outputs);
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
        runContext,
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
      rawContent: updatedContent,
    };
  }

  private async runCell(params: {
    cell: Cell;
    platform: PlatformAdapter;
    permissions: ResolvedPermissions;
    outputs: Map<string, CellOutput>;
    runtime: typeof DEFAULT_RUNTIME;
    runContext: RunContext;
  }): Promise<CellOutput> {
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
}

// =============================================================================
// EXECUTION HELPERS
// =============================================================================

interface ResolvedPermissions {
  network: boolean;
  buildNetwork: boolean;
  vaultRead: boolean;
  vaultWrite: boolean;
}

interface RunContext {
  runId: string;
  runDir: string;
  runBaseDir: string;
  startedAt: string;
  workflowPath: string;
  outputRoot: string;
}

async function resolvePermissions(
  platform: PlatformAdapter,
  workflowPath: string,
  frontmatter: WorkflowFrontmatter
): Promise<ResolvedPermissions> {
  const merged: WorkflowPermissions = {
    ...DEFAULT_PERMISSIONS,
    ...frontmatter.permissions,
  };

  const stored = (platform.getSetting<Record<string, WorkflowPermissions>>(
    "vaultore.permissionDecisions"
  ) ?? {}) as Record<string, WorkflowPermissions>;

  const current = stored[workflowPath];
  const resolved: WorkflowPermissions = { ...merged };

  for (const key of Object.keys(merged) as (keyof WorkflowPermissions)[]) {
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
    vaultWrite: resolved.vaultWrite === "allow",
  };
}

async function ensureRuntimeAvailable(engine: string): Promise<void> {
  const detection = await detectRuntimes();
  if (!detection.available.includes(engine as never)) {
    const error = detection.errors.get(engine as never) ?? "runtime not available";
    throw new Error(`Container runtime ${engine} not available: ${error}`);
  }
}

function orderCells(cells: Cell[]): Cell[] {
  const byId = new Map<string, Cell>();
  const deps = new Map<string, Set<string>>();
  const dependents = new Map<string, Set<string>>();

  for (const cell of cells) {
    byId.set(cell.attributes.id, cell);
    deps.set(cell.attributes.id, new Set(cell.attributes.depends ?? []));
    dependents.set(cell.attributes.id, new Set());
  }

  for (const cell of cells) {
    for (const dep of cell.attributes.depends ?? []) {
      dependents.get(dep)?.add(cell.attributes.id);
    }
  }

  const ready = Array.from(deps.entries())
    .filter(([, depsSet]) => depsSet.size === 0)
    .map(([id]) => id);

  const ordered: Cell[] = [];

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

function filterCellsForTarget(
  cells: Cell[],
  targetId: string,
  includeDependencies = true
): Cell[] {
  if (!includeDependencies) {
    return cells.filter((cell) => cell.attributes.id === targetId);
  }

  const byId = new Map(cells.map((cell) => [cell.attributes.id, cell]));
  const result: Cell[] = [];
  const visited = new Set<string>();

  function visit(id: string) {
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

function buildOutput(
  cellId: string,
  value: unknown,
  start: number,
  status: OutputMeta["status"] = "success"
): CellOutput {
  return {
    cellId,
    value,
    meta: {
      status,
      duration: Date.now() - start,
      timestamp: new Date().toISOString(),
      error: status === "error" ? String(value) : undefined,
    },
  };
}

async function createRunContext(
  platform: PlatformAdapter,
  workflowPath: string
): Promise<RunContext> {
  const startedAt = new Date().toISOString();
  const runId = createRunId();
  const outputRootSetting = platform.getSetting<string>("vaultore.outputRoot");
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
        status: "running",
      },
      null,
      2
    )
  );

  return { runId, runDir, runBaseDir, startedAt, workflowPath, outputRoot };
}

async function hydrateOutputsFromStubs(
  parser: WorkflowParser,
  platform: PlatformAdapter,
  content: string,
  outputs: Map<string, CellOutput>
): Promise<void> {
  const stubs = parser.parseOutputStubs(content);
  for (const [cellId, stub] of stubs.entries()) {
    if (outputs.has(cellId)) continue;
    if (!stub.outputPath) continue;
    if (!(await platform.exists(stub.outputPath))) continue;

    try {
      const raw = await platform.readFile(stub.outputPath);
      const record = JSON.parse(raw) as {
        cellId?: string;
        value?: unknown;
        meta?: OutputMeta;
      };
      if (!record?.meta || !record.cellId) continue;

      outputs.set(cellId, {
        cellId,
        value: record.value,
        meta: record.meta,
      });
    } catch {
      // Ignore malformed output files
    }
  }
}

async function persistCellOutput(
  platform: PlatformAdapter,
  runContext: RunContext,
  workflowPath: string,
  output: CellOutput
): Promise<string> {
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
      outputViewPath,
    },
  };

  await platform.writeFile(outputPath, JSON.stringify(record, null, 2));
  await platform.writeFile(
    outputViewPath,
    renderOutputMarkdown(output.cellId, record.meta, output.value, outputPath)
  );
  await updateRunIndex(platform, runContext, outputPath, outputViewPath, output);

  return outputPath;
}

async function updateRunIndex(
  platform: PlatformAdapter,
  runContext: RunContext,
  outputPath: string,
  outputViewPath: string,
  output: CellOutput
): Promise<void> {
  const indexPath = `${runContext.runBaseDir}/index.json`;
  let index: {
    workflowPath?: string;
    runs: Array<{
      runId: string;
      startedAt: string;
      status: "running" | "success" | "error";
      outputs: Record<
        string,
        {
          outputPath: string;
          outputViewPath: string;
          status: OutputMeta["status"];
          timestamp: string;
          artifacts?: { artifactDir?: string; files?: string[] };
        }
      >;
    }>;
  } = { runs: [] };

  if (await platform.exists(indexPath)) {
    try {
      const raw = await platform.readFile(indexPath);
      const parsed = JSON.parse(raw) as typeof index;
      if (parsed?.runs) index = parsed;
    } catch {
      // Ignore corrupted index and rebuild
    }
  }

  index.workflowPath = index.workflowPath ?? runContext.workflowPath;

  let runEntry = index.runs.find((run) => run.runId === runContext.runId);
  if (!runEntry) {
    runEntry = {
      runId: runContext.runId,
      startedAt: runContext.startedAt,
      status: "running",
      outputs: {},
    };
    index.runs.unshift(runEntry);
  }

  runEntry.outputs[output.cellId] = {
    outputPath,
    outputViewPath,
    status: output.meta.status,
    timestamp: output.meta.timestamp,
    ...(output.meta.artifacts ? { artifacts: output.meta.artifacts } : {}),
  };

  if (output.meta.status === "error") {
    runEntry.status = "error";
  } else if (runEntry.status !== "error") {
    runEntry.status = "success";
  }

  await platform.writeFile(indexPath, JSON.stringify(index, null, 2));
}

function createRunId(): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const rand = Math.random().toString(36).slice(2, 8);
  return `${timestamp}-${rand}`;
}

function runBasePath(outputRoot: string, workflowPath: string): string {
  const normalized = workflowPath
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\.\./g, "")
    .replace(/\.md$/i, "");
  return `${outputRoot}/runs/${normalized || "workflow"}`;
}

function safeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function normalizeOutputRoot(value: string | undefined): string {
  const fallback = "_vaultore";
  if (!value) return fallback;
  const normalized = value
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .trim();
  return normalized || fallback;
}

function extractArtifacts(
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

async function ensureArtifactIndex(
  platform: PlatformAdapter,
  runContext: RunContext,
  output: CellOutput,
  artifacts: { artifactDir?: string; files?: string[] }
): Promise<void> {
  if (!artifacts.artifactDir) return;
  const dir = artifacts.artifactDir.replace(/\/+$/, "");
  const indexPath = `${dir}/_index.md`;
  await platform.mkdirp(dir);

  const lines: string[] = [
    "---",
    "vaultore: artifacts",
    `runId: ${runContext.runId}`,
    `cellId: ${output.cellId}`,
    `workflowPath: ${runContext.workflowPath}`,
    `created: ${output.meta.timestamp}`,
    `artifactDir: ${dir}`,
    "---",
    "",
    "# Artifacts",
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

function extractVaultoreOutput(stdout: string): { found: boolean; payload: string } {
  const match = stdout.match(
    /__VAULTORE_OUTPUT_START__\s*([\s\S]*?)\s*__VAULTORE_OUTPUT_END__/
  );
  if (!match?.[1]) {
    return { found: false, payload: "" };
  }
  return { found: true, payload: match[1].trim() };
}

function renderOutputMarkdown(
  cellId: string,
  meta: OutputMeta,
  value: unknown,
  outputPath: string
): string {
  const frontmatter: string[] = [
    "---",
    "vaultore: output",
    `cellId: ${cellId}`,
    `runId: ${meta.runId ?? ""}`,
    `status: ${meta.status}`,
    `timestamp: ${meta.timestamp}`,
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

async function executeTypeScriptCell(
  cell: Cell,
  platform: PlatformAdapter,
  permissions: ResolvedPermissions,
  outputs: Map<string, CellOutput>,
  runtime: typeof DEFAULT_RUNTIME,
  runContext: RunContext
): Promise<unknown> {
  const vaultRoot = await platform.getVaultRoot();
  const runtimeScript = buildTypeScriptRuntime(outputs, permissions, runContext);
  const { body, lastExpression } = extractLastExpression(cell.content);

  const script = `${runtimeScript}\n\nconst __vaultore_value = await (async () => {\n${body}\nreturn ${lastExpression};\n})();\nconst __vaultore_payload = JSON.stringify(__vaultore_value);\nconsole.log("__VAULTORE_OUTPUT_START__");\nconsole.log(__vaultore_payload);\nconsole.log("__VAULTORE_OUTPUT_END__");\n`;

  const containerOpts: ContainerExecOptions = {
    image: runtime.image,
    command: ["sh", "-lc", "cat > /tmp/vaultore.ts && bun /tmp/vaultore.ts"],
    workdir: "/workspace",
    env: {
      VAULTORE_RUN_ID: runContext.runId,
      VAULTORE_OUTPUT_ROOT: runContext.outputRoot,
      VAULTORE_RUN_DIR: runContext.runDir,
    },
    stdin: script,
    timeout: (cell.attributes.timeout ?? runtime.timeout) * 1000,
    memoryLimit: runtime.memoryLimit,
    cpuLimit: runtime.cpuLimit,
    networkEnabled: permissions.network,
    mounts: [
      {
        source: vaultRoot,
        target: "/workspace",
        readonly: !permissions.vaultWrite,
      },
    ],
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

async function executeShellCell(
  cell: Cell,
  platform: PlatformAdapter,
  permissions: ResolvedPermissions,
  runtime: typeof DEFAULT_RUNTIME,
  runContext: RunContext
): Promise<string> {
  const vaultRoot = await platform.getVaultRoot();
  const image = "alpine:3.19";
  const command = ["sh", "-lc", cell.content];

  const containerOpts: ContainerExecOptions = {
    image,
    command,
    workdir: "/workspace",
    env: {
      VAULTORE_RUN_ID: runContext.runId,
      VAULTORE_OUTPUT_ROOT: runContext.outputRoot,
      VAULTORE_RUN_DIR: runContext.runDir,
    },
    timeout: (cell.attributes.timeout ?? runtime.timeout) * 1000,
    memoryLimit: runtime.memoryLimit,
    cpuLimit: runtime.cpuLimit,
    networkEnabled: permissions.network,
    mounts: [
      {
        source: vaultRoot,
        target: "/workspace",
        readonly: !permissions.vaultWrite,
      },
    ],
  };

  const result = await execContainer(runtime.engine, containerOpts);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || `shell cell failed: exit ${result.exitCode}`);
  }

  return result.stdout;
}

async function executeAICell(
  cell: Cell,
  platform: PlatformAdapter,
  permissions: ResolvedPermissions,
  outputs: Map<string, CellOutput>,
  interpolator: TemplateInterpolator
): Promise<string> {
  if (!permissions.network) {
    throw new Error("AI cells require network permission");
  }

  const model =
    cell.attributes.model ??
    platform.getSetting<string>("vaultore.defaultModel") ??
    "gpt-4o-mini";

  const providerName =
    platform.getSetting<string>("vaultore.defaultProvider") ?? "openai";

  const provider = await createProviderFromSettings(platform, providerName);
  const temperature =
    cell.attributes.temperature ??
    platform.getSetting<number>("vaultore.aiTemperature");
  const maxTokens =
    cell.attributes.maxTokens ??
    platform.getSetting<number>("vaultore.aiMaxTokens");
  const prompt = await interpolator.interpolateAsync(
    cell.content,
    outputs,
    (path) => platform.readFile(path)
  );

  const response = await provider.complete({
    model,
    prompt,
    temperature,
    maxTokens,
  });

  return response.content;
}

function buildTypeScriptRuntime(
  outputs: Map<string, CellOutput>,
  permissions: ResolvedPermissions,
  runContext: RunContext
): string {
  const outputsJson = JSON.stringify(
    Object.fromEntries(
      Array.from(outputs.entries()).map(([id, output]) => [
        id,
        output.value,
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

function extractLastExpression(code: string): { body: string; lastExpression: string } {
  try {
    const ast = parse(code, {
      sourceType: "module",
      plugins: ["typescript", "topLevelAwait"],
      ranges: true,
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

    const lastNode: any = bodyNodes[idx];
    if (lastNode.type === "ExpressionStatement") {
      const statementStart = lastNode.start ?? 0;
      const statementEnd = lastNode.end ?? code.length;
      const exprStart = lastNode.expression?.start ?? statementStart;
      const exprEnd = lastNode.expression?.end ?? statementEnd;

      const body = `${code.slice(0, statementStart)}${code.slice(statementEnd)}`.trimEnd();
      const lastExpression = code.slice(exprStart, exprEnd).trim();
      return {
        body,
        lastExpression: lastExpression || "undefined",
      };
    }

    return { body: code, lastExpression: "undefined" };
  } catch {
    return { body: code, lastExpression: "undefined" };
  }
}

// No temp file helpers needed with stdin execution.
