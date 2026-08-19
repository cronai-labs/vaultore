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
import {
  OutputSerializer,
  TemplateInterpolator,
  WorkflowParser,
  stripLeading,
  stripTrailing,
} from "../parser";
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

    const outputs = new Map<string, CellOutput>(workflow.outputs);
    let updatedContent = workflow.rawContent;

    // Cells this invocation ran, so the run record reflects the run rather than
    // every output hydrated from earlier ones.
    const ran: string[] = [];
    let runError: unknown;

    // Everything after the run record exists is inside the try. Setup can fail
    // too — an unavailable engine throws from ensureRuntimeAvailable — and that
    // failure used to escape before any finally, leaving the record this method
    // just wrote stuck at "running" forever.
    try {
      const permissions = await resolvePermissions(
        options.platform,
        workflow.path,
        workflow.frontmatter
      );

      const engineChoice = resolveEngine(
        workflow.frontmatter.runtime?.engine,
        options.platform.getSetting<string>("vaultore.runtimeEngine")
      );
      const runtime = {
        ...DEFAULT_RUNTIME,
        ...workflow.frontmatter.runtime,
        engine: engineChoice.engine,
      };

      await ensureRuntimeAvailable(engineChoice);

      const orderedCells = orderCells(workflow.cells);
      const cellsToRun = options.targetCellId
        ? filterCellsForTarget(
            orderedCells,
            options.targetCellId,
            !options.skipDependencies
          )
        : orderedCells;
      await hydrateOutputsFromStubs(
        this.parser,
        options.platform,
        workflow.rawContent,
        outputs
      );

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
        ran.push(cell.attributes.id);

        updatedContent = await this.writeBackOutput(
          options.platform,
          workflow.path,
          updatedContent,
          result
        );
        options.emitEvent?.("cell:completed", { cellId: cell.attributes.id });
      }
    } catch (err) {
      // Captured so the record reflects it. Rethrown unchanged — finalising is
      // bookkeeping and must not alter what the caller sees.
      runError = err;
      throw err;
    } finally {
      await finalizeRunContext(options.platform, runContext, ran, outputs, runError);
    }

    return {
      ...workflow,
      outputs,
      rawContent: updatedContent,
    };
  }

  /**
   * Splice one cell's output into the note and persist it.
   *
   * The note is re-read first. A run holds a snapshot from before it started,
   * and writing that snapshot back discards anything the user typed while the
   * run was in flight — which is easy to hit, because the write happens once
   * per cell and container and AI cells are slow. `updateWorkflowOutput` is a
   * pure per-cell splice, so applying it to current content preserves those
   * edits and still lands the output in the right place.
   *
   * Returns the content now on disk, which becomes the fallback base if a later
   * re-read fails.
   */
  private async writeBackOutput(
    platform: PlatformAdapter,
    workflowPath: string,
    lastKnownContent: string,
    result: CellOutput
  ): Promise<string> {
    // A note deleted or renamed mid-run must not be recreated from the
    // snapshot: the platform's writeFile falls back to creating the file, which
    // would resurrect a note the user just deleted. The output is already
    // persisted under the run directory either way.
    if (!(await platform.exists(workflowPath))) {
      return lastKnownContent;
    }

    let base = lastKnownContent;
    try {
      base = await platform.readFile(workflowPath);
    } catch {
      // Unreadable but present: fall back to what we last wrote rather than
      // losing the output entirely.
    }

    const next = this.serializer.updateWorkflowOutput(base, result);
    await platform.writeFile(workflowPath, next);
    return next;
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

/**
 * Where the engine came from. A workflow note that names an engine wins over
 * the user's configured default, so when it fails the message has to say which
 * source asked for it — otherwise "docker not available" is baffling to someone
 * who selected colima in settings.
 */
export interface EngineChoice {
  engine: RuntimeEngine;
  source: "workflow" | "setting" | "default";
  /** The user's configured default, when they have one and it is not what ran. */
  configuredDefault?: RuntimeEngine;
}

export function resolveEngine(
  frontmatterEngine: string | undefined,
  settingEngine: string | undefined
): EngineChoice {
  const configuredDefault = settingEngine as RuntimeEngine | undefined;

  if (frontmatterEngine) {
    return {
      engine: frontmatterEngine as RuntimeEngine,
      source: "workflow",
      ...(configuredDefault && configuredDefault !== frontmatterEngine
        ? { configuredDefault }
        : {}),
    };
  }

  if (settingEngine) {
    return { engine: settingEngine as RuntimeEngine, source: "setting" };
  }

  return { engine: DEFAULT_RUNTIME.engine, source: "default" };
}

export function describeEngineFailure(
  choice: EngineChoice,
  detail: string,
  available: readonly RuntimeEngine[]
): string {
  const lines = [`Container runtime "${choice.engine}" is not available: ${detail}`];

  if (choice.source === "workflow") {
    lines.push(`This workflow's frontmatter requests "${choice.engine}".`);
    if (choice.configuredDefault) {
      lines.push(
        `Your configured default is "${choice.configuredDefault}", but frontmatter takes precedence.`,
        `Remove "engine: ${choice.engine}" from the note to use your default, or start ${choice.engine}.`
      );
    }
  } else if (choice.source === "setting") {
    lines.push(`"${choice.engine}" is your configured default in VaultOre settings.`);
  }

  lines.push(
    available.length > 0
      ? `Detected on this machine: ${available.join(", ")}.`
      : "No container runtime was detected on this machine."
  );

  return lines.join("\n");
}

async function ensureRuntimeAvailable(choice: EngineChoice): Promise<void> {
  const detection = await detectRuntimes();
  if (detection.available.includes(choice.engine)) return;

  const detail = detection.errors.get(choice.engine) ?? "runtime not available";
  throw new Error(describeEngineFailure(choice, detail, detection.available));
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

/**
 * Close out run.json with a terminal status and a per-cell summary.
 *
 * Best effort: a failure to write the record must not mask whatever error is
 * already propagating out of the run.
 */
export async function finalizeRunContext(
  platform: PlatformAdapter,
  runContext: RunContext,
  ran: readonly string[],
  outputs: ReadonlyMap<string, CellOutput>,
  runError?: unknown
): Promise<void> {
  const cells = ran.map((cellId) => ({
    cellId,
    status: outputs.get(cellId)?.meta.status ?? "error",
    durationMs: outputs.get(cellId)?.meta.duration,
  }));

  const failed = cells.filter((c) => c.status !== "success").length;
  const finishedAt = new Date().toISOString();
  const startedMs = Date.parse(runContext.startedAt);

  // An error that escaped the run is authoritative. `ran` only holds cells that
  // were persisted, so a throw part-way through leaves the recorded cells all
  // green — reporting that as "completed" would claim success for a run the
  // caller saw fail.
  const status = runError !== undefined ? "aborted" : failed > 0 ? "failed" : "completed";

  try {
    await platform.writeFile(
      `${runContext.runDir}/run.json`,
      JSON.stringify(
        {
          runId: runContext.runId,
          workflowPath: runContext.workflowPath,
          startedAt: runContext.startedAt,
          finishedAt,
          ...(Number.isFinite(startedMs)
            ? { durationMs: Date.parse(finishedAt) - startedMs }
            : {}),
          status,
          ...(runError !== undefined
            ? { error: runError instanceof Error ? runError.message : String(runError) }
            : {}),
          cells,
        },
        null,
        2
      )
    );
  } catch {
    // Swallowed on purpose — see the doc comment.
  }
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
  // Anchored /+ quantifiers backtrack across every offset on a long run of
  // slashes (CodeQL js/polynomial-redos); the helpers are linear.
  const normalized = stripTrailing(
    stripLeading(value.replace(/\\/g, "/"), "/"),
    "/"
  ).trim();
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

  // Frontmatter follows the Open Knowledge Format (OKF) v0.1: `type` is the
  // one required field, so artifact indexes are valid OKF concepts and any
  // OKF consumer can ingest the output tree as a knowledge bundle.
  const lines: string[] = [
    "---",
    "type: VaultOre Artifacts",
    `title: Artifacts for ${output.cellId}`,
    `description: Files produced by cell ${output.cellId} of ${runContext.workflowPath}.`,
    `timestamp: ${output.meta.timestamp}`,
    "tags: [vaultore, artifacts]",
    "vaultore: artifacts",
    `runId: ${runContext.runId}`,
    `cellId: ${output.cellId}`,
    `workflowPath: ${runContext.workflowPath}`,
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

    const lastNode = bodyNodes[idx];
    if (lastNode?.type === "ExpressionStatement") {
      const statementStart = lastNode.start ?? 0;
      const statementEnd = lastNode.end ?? code.length;
      const exprStart = lastNode.expression.start ?? statementStart;
      const exprEnd = lastNode.expression.end ?? statementEnd;

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
