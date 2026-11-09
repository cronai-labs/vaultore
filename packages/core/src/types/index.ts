/**
 * @vaultore/core - Type Definitions
 *
 * These types are the foundation of VaultOre. They define the shape of
 * workflows, cells, outputs, and the platform abstraction layer.
 *
 * @packageDocumentation
 */

import { z } from "zod";

// =============================================================================
// PERMISSION TYPES
// =============================================================================

/**
 * Permission levels for workflow capabilities
 */
export type PermissionLevel = "allow" | "deny" | "ask";

/**
 * Workflow permissions defined in frontmatter
 */
export interface WorkflowPermissions {
  /** Runtime network access */
  network: PermissionLevel;
  /** Build-time network (Go modules, pip) */
  buildNetwork: PermissionLevel;
  /** Write/create notes in vault */
  vaultWrite: PermissionLevel;
  /** Read notes from vault */
  vaultRead: PermissionLevel;
}

export const DEFAULT_PERMISSIONS: WorkflowPermissions = {
  network: "deny",
  // Nothing uses it until Python or Go cells download dependencies; `ask` would
  // prompt every workflow for a capability that does nothing (#95).
  buildNetwork: "deny",
  vaultWrite: "deny",
  vaultRead: "allow",
};

// =============================================================================
// RUNTIME TYPES
// =============================================================================

/**
 * Available container runtime engines
 *
 * - docker/podman: standard OCI runtimes (Linux, macOS, Windows via WSL2)
 * - colima: docker-compatible runtime on macOS (uses the docker CLI)
 * - apple: Apple's `container` CLI (macOS 26+, Apple silicon) — runs each
 *   container in a lightweight VM; `network: deny` maps to `--network none`
 */
export type RuntimeEngine = "docker" | "podman" | "colima" | "apple";

/**
 * Runtime configuration for workflow execution
 */
export interface RuntimeConfig {
  engine: RuntimeEngine;
  image: string;
  timeout: number; // seconds
  memoryLimit: string; // e.g., "512m"
  cpuLimit: number;
}

export const DEFAULT_RUNTIME: RuntimeConfig = {
  engine: "docker",
  image: "oven/bun:1-alpine",
  timeout: 60,
  memoryLimit: "512m",
  cpuLimit: 1,
};

/**
 * The longest time limit of a container cell, in seconds: a day (Ore §3.3,
 * §5.3). There is no value that means "no limit".
 */
export const MAX_TIMEOUT_SECONDS = 86_400;

/** What a time limit has to be, as the error messages say it. */
export const TIMEOUT_RULE = `a number of seconds greater than 0 and at most ${MAX_TIMEOUT_SECONDS}`;

/** Whether `seconds` can be the time limit of a container cell. */
export function isTimeoutSeconds(seconds: unknown): seconds is number {
  return (
    typeof seconds === "number" &&
    Number.isFinite(seconds) &&
    seconds > 0 &&
    seconds <= MAX_TIMEOUT_SECONDS
  );
}

/** Whether `cpus` can be a container's CPU limit. The engines read 0 as "no limit". */
export function isCpuLimit(cpus: unknown): cpus is number {
  return typeof cpus === "number" && Number.isFinite(cpus) && cpus > 0;
}

/**
 * Whether `amount` can be a container's memory limit: a number greater than
 * zero and an optional unit, as in `512m`. The engines read an amount of 0 as
 * "no limit" whatever its unit, and refuse an empty one. Which units exist is
 * the engine's business, so any short run of letters passes here and a unit
 * the engine does not know fails the cell there, with the engine's message.
 */
export function isMemoryLimit(amount: unknown): amount is string {
  if (typeof amount !== "string") return false;
  const match = /^(\d+(?:\.\d+)?) ?[A-Za-z]{0,3}$/.exec(amount);
  return match !== null && Number(match[1]) > 0;
}

/**
 * Container runtime detection result
 */
export interface RuntimeDetection {
  available: RuntimeEngine[];
  preferred: RuntimeEngine | null;
  errors: Map<RuntimeEngine, string>;
}

/**
 * Container execution options
 */
export interface ContainerExecOptions {
  image: string;
  command: string[];
  workdir?: string;
  env?: Record<string, string>;
  /**
   * Time limit in milliseconds: greater than 0 and at most what a timer holds
   * (2^31-1). Left out, the container runs without one; any other value is
   * refused.
   */
  timeout?: number;
  /** Passed as `--memory`: an amount greater than zero, such as `512m`. Left out, no limit is set. */
  memoryLimit?: string;
  /** Passed as `--cpus`: a number greater than 0. Left out, no limit is set. */
  cpuLimit?: number;
  networkEnabled?: boolean;
  mounts?: ContainerMount[];
  stdin?: string;
  /** `uid:gid` the cell runs as; defaults to `containerUser()`. */
  user?: string;
  /** Process cap; defaults to `DEFAULT_PIDS_LIMIT`. Ignored by Apple container. */
  pidsLimit?: number;
  /**
   * Container paths hidden behind an empty read-only tmpfs. Each must exist
   * under a mount, or the engine has to create the mount point.
   */
  maskedPaths?: string[];
  /**
   * The container's name, which a timeout uses to kill it. `execContainer`
   * picks a unique one when it is not given.
   */
  name?: string;
}

/**
 * Container mount configuration
 */
export interface ContainerMount {
  source: string;
  target: string;
  readonly?: boolean;
}

/**
 * Container execution result
 */
export interface ContainerExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  duration: number;
  /** The run hit `timeout`; the container was then killed and `exitCode` is 1. */
  timedOut: boolean;
}

// =============================================================================
// WORKFLOW TYPES
// =============================================================================

/**
 * Go runtime configuration (v0.3+)
 */
export interface GoConfig {
  version: string;
  builderImage: string;
  cgo: 0 | 1;
  tags: string;
  ldflags: string;
  cache: {
    enabled: boolean;
    dir: string;
  };
}

export const DEFAULT_GO_CONFIG: GoConfig = {
  version: "1.23",
  builderImage: "ghcr.io/vaultore/go-builder:1.23",
  cgo: 0,
  tags: "",
  ldflags: "-s -w",
  cache: {
    enabled: true,
    dir: ".vaultore/cache/go",
  },
};

/**
 * Complete workflow frontmatter schema
 */
export interface WorkflowFrontmatter {
  ore: true;
  name: string;
  version?: string;
  author?: string;
  tags?: string[];
  description?: string;
  runtime?: Partial<RuntimeConfig>;
  permissions?: Partial<WorkflowPermissions>;
  schedule?: string; // cron syntax
  go?: Partial<GoConfig>; // v0.3+
}

/**
 * Zod schema for validating frontmatter
 */
/**
 * A front matter value that must pass `test`. The message says what was
 * expected and what was written; the parser puts the key in front of it.
 */
function limit<T>(test: (value: unknown) => value is T, expected: string) {
  return z.custom<T>(test, {
    error: (issue) => `expected ${expected}, got ${written(issue.input)}`,
  });
}

/** A value as its author would recognise it: JSON, except for numbers JSON has no word for. */
function written(value: unknown): string {
  return typeof value === "number" ? String(value) : (JSON.stringify(value) ?? String(value));
}

export const WorkflowFrontmatterSchema = z.object({
  ore: z.literal(true),
  name: z.string(),
  version: z.string().optional(),
  author: z.string().optional(),
  tags: z.array(z.string()).optional(),
  description: z.string().optional(),
  runtime: z
    .object({
      engine: z.enum(["docker", "podman", "colima", "apple"]).optional(),
      image: z.string().optional(),
      // Each of these limits has a value that switches it off (`timeout: 0`,
      // `cpuLimit: 0`, `memoryLimit: "0"`). None is accepted: a note must not
      // be able to remove its own limits, least of all one that arrived
      // through sync (#210, #222).
      timeout: limit(isTimeoutSeconds, TIMEOUT_RULE).optional(),
      memoryLimit: limit(
        isMemoryLimit,
        'an amount of memory greater than zero, such as "512m"'
      ).optional(),
      cpuLimit: limit(isCpuLimit, "a number of CPUs greater than 0").optional(),
    })
    .optional(),
  permissions: z
    .object({
      network: z.enum(["allow", "deny", "ask"]).optional(),
      buildNetwork: z.enum(["allow", "deny", "ask"]).optional(),
      vaultWrite: z.enum(["allow", "deny", "ask"]).optional(),
      vaultRead: z.enum(["allow", "deny", "ask"]).optional(),
    })
    .optional(),
  schedule: z.string().optional(),
  go: z
    .object({
      version: z.string().optional(),
      builderImage: z.string().optional(),
      cgo: z.union([z.literal(0), z.literal(1)]).optional(),
      tags: z.string().optional(),
      ldflags: z.string().optional(),
      cache: z
        .object({
          enabled: z.boolean().optional(),
          dir: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
});

// =============================================================================
// CELL TYPES
// =============================================================================

/**
 * Supported cell types
 */
export type CellType = "ts" | "shell" | "ai" | "py" | "go";

/**
 * Cell attributes parsed from code fence
 */
export interface CellAttributes {
  id: string;
  type: CellType;
  depends?: string[];
  timeout?: number;
  env?: Record<string, string>;

  // AI-specific
  model?: string;
  temperature?: number;
  maxTokens?: number;

  // Go-specific (v0.3+)
  mode?: "tool" | "module";
  stdin?: string;
  stdout?: "text" | "json" | "jsonl";
  goVersion?: string;
  builderImage?: string;
  cgo?: 0 | 1;
  tags?: string;
  ldflags?: string;
  args?: string;
  modulePath?: string;
}

/**
 * A parsed cell from the workflow
 */
export interface Cell {
  attributes: CellAttributes;
  content: string;
  startLine: number;
  endLine: number;
  rawBlock: string;
}

/**
 * An HTTP request sent through {@link PlatformAdapter.request}.
 */
/**
 * A handle returned by a {@link Timers} function: a number in a browser
 * window, an object in Node. Opaque to core: only the matching clear function
 * of the same `Timers` reads it.
 */
export type TimerHandle = number | object;

/**
 * The timer functions core uses, supplied by the platform. Core runs in an
 * Obsidian window and in Node, so it calls no global timer itself: the plugin
 * passes its window's timers (and ties intervals to its lifecycle), the CLI
 * passes Node's.
 */
export interface Timers {
  setTimeout(callback: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
  setInterval(callback: () => void, ms: number): TimerHandle;
  clearInterval(handle: TimerHandle): void;
}

export interface PlatformRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  /**
   * Core bounds every request by this many milliseconds whatever the
   * transport does; a transport that can abort (fetch) should abort at the
   * same point so the connection is released.
   */
  timeoutMs: number;
}

/**
 * The answer to a {@link PlatformRequest}. Every HTTP status resolves,
 * 4xx and 5xx included, so the caller can report the body; only a
 * transport failure (no connection, timeout) rejects.
 */
export interface PlatformResponse {
  status: number;
  text: string;
}

/**
 * Output metadata stored with cell results
 */
export interface OutputMeta {
  status: "success" | "error" | "timeout" | "cancelled";
  duration: number; // milliseconds
  timestamp: string; // ISO 8601
  error?: string;
  cache?: "hit" | "miss"; // For Go cells
  artifact?: string; // Path to cached artifact
  exitCode?: number;
  runId?: string;
  outputPath?: string;
  outputViewPath?: string;
  artifacts?: {
    artifactDir?: string;
    files?: string[];
  };
  go?: {
    version: string;
    cgo: 0 | 1;
    tags: string;
    ldflags: string;
  };
}

/**
 * A cell's output. Persisted as a JSON record under the run directory and
 * linked from an ore-output callout in the note; older notes held it in an
 * HTML comment, which the parser still reads.
 */
export interface CellOutput {
  cellId: string;
  value: unknown;
  meta: OutputMeta;
}

// =============================================================================
// WORKFLOW TYPES
// =============================================================================

/**
 * A complete parsed workflow
 */
export interface Workflow {
  path: string;
  frontmatter: WorkflowFrontmatter;
  cells: Cell[];
  outputs: Map<string, CellOutput>;
  rawContent: string;
}

/**
 * Execution state for a running workflow
 */
export interface WorkflowExecution {
  workflow: Workflow;
  currentCellIndex: number;
  startTime: Date;
  status: "running" | "completed" | "failed" | "cancelled";
  results: Map<string, CellOutput>;
}

// =============================================================================
// PROVIDER TYPES
// =============================================================================

/**
 * AI provider configuration
 */
export interface ProviderConfig {
  apiKey: string;
  baseUrl?: string;
  defaultModel: string;
}

/**
 * AI completion request
 */
export interface CompletionRequest {
  model: string;
  prompt: string;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
}

/**
 * AI completion response
 */
export interface CompletionResponse {
  content: string;
  model: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

/**
 * AI provider interface
 */
export interface AIProvider {
  name: string;
  complete(request: CompletionRequest): Promise<CompletionResponse>;
  listModels?(): Promise<string[]>;
}

// =============================================================================
// SCHEDULER TYPES
// =============================================================================

/**
 * Scheduled workflow entry
 */
export interface ScheduledWorkflow {
  path: string;
  cronExpression: string;
  nextRun: Date;
  lastRun?: Date;
  lastStatus?: "success" | "error";
  enabled: boolean;
}

// =============================================================================
// PLATFORM ADAPTER
// =============================================================================

/**
 * Progress handle for long-running operations
 */
export interface ProgressHandle {
  update(message: string, percent?: number): void;
  complete(): void;
}

/**
 * Platform adapter interface - implemented by each editor
 */
export interface PlatformAdapter {
  readonly platform: "obsidian" | "vscode" | "zed" | "cli";

  // File system operations
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  mkdirp(path: string): Promise<void>;
  listFiles(directory: string, pattern?: string): Promise<string[]>;
  readRaw?(path: string): Promise<string>; // For /proc, etc.
  getVaultRoot(): Promise<string>;
  /**
   * The vault-relative path `path` really leads to, or a thrown error when it
   * leaves the vault: through `..`, or through a symbolic link a cell may have
   * planted via its mount. The executor reads and writes vault paths only
   * through this, and refuses to run on a platform without it.
   * `resolveInVaultRoot` implements it for a vault on a file system.
   */
  resolveInVault(path: string): Promise<string>;
  /**
   * The vault's configuration folder, one vault-relative folder name: what
   * Obsidian's `Vault#configDir` returns, `.obsidian` unless the user chose
   * another. The executor hides it from cells.
   */
  readonly configDir: string;

  // Settings
  getSetting<T>(key: string): T | undefined;
  setSetting<T>(key: string, value: T): Promise<void>;

  // Secrets
  getSecret(key: string): Promise<string | undefined>;
  setSecret(key: string, value: string): Promise<void>;
  deleteSecret(key: string): Promise<void>;

  // HTTP. AI providers send only through this; core never calls `fetch`. The
  // Obsidian plugin passes `requestUrl`: `fetch` from the renderer carries a
  // browser Origin and is subject to CORS. The CLI uses `fetch`.
  request(request: PlatformRequest): Promise<PlatformResponse>;

  // Timers for request deadlines, engine probes and container runs.
  readonly timers: Timers;

  // UI (optional)
  showNotification?(
    message: string,
    type: "info" | "warning" | "error"
  ): void;
  showProgress?(title: string): ProgressHandle;
  confirm?(message: string): Promise<boolean>;

  // Logging
  log(
    level: "debug" | "info" | "warn" | "error",
    message: string,
    data?: unknown
  ): void;
}

// =============================================================================
// EVENT TYPES
// =============================================================================

/**
 * Events emitted by the core engine
 */
export type CoreEvent =
  | { type: "workflow:parsed"; workflow: Workflow }
  | { type: "cell:started"; cellId: string; workflow: string }
  | { type: "cell:output"; cellId: string; output: CellOutput }
  | { type: "cell:completed"; cellId: string; output: CellOutput }
  | { type: "cell:failed"; cellId: string; error: string }
  | {
      type: "workflow:completed";
      workflow: string;
      results: Map<string, CellOutput>;
    }
  | { type: "workflow:failed"; workflow: string; error: string }
  | { type: "scheduler:tick"; workflows: ScheduledWorkflow[] }
  | { type: "scheduler:run"; workflowPath: string }
  | { type: "permission:requested"; permission: keyof WorkflowPermissions }
  | {
      type: "permission:granted";
      permission: keyof WorkflowPermissions;
      workflow: string;
    }
  | {
      type: "permission:denied";
      permission: keyof WorkflowPermissions;
      workflow: string;
    };

/**
 * Event listener type
 */
export type CoreEventListener = (event: CoreEvent) => void;

// =============================================================================
// DAG TYPES (v0.2)
// =============================================================================

/**
 * Cell dependency node in the DAG
 */
export interface DependencyNode {
  cellId: string;
  dependencies: string[];
  dependents: string[];
  lastOutput?: CellOutput;
  isStale: boolean;
}

/**
 * Dependency graph for a workflow
 */
export interface DependencyGraph {
  nodes: Map<string, DependencyNode>;
  executionOrder: string[];
  hasCycle: boolean;
  cycleNodes?: string[];
}

// =============================================================================
// GO CACHE TYPES (v0.3)
// =============================================================================

/**
 * Go build cache entry
 */
export interface GoCacheEntry {
  cacheKey: string;
  goVersion: string;
  builderImage: string;
  cgo: 0 | 1;
  tags: string;
  ldflags: string;
  platform: string;
  sourceHash: string;
  depsHash: string;
  artifactSize: number;
  artifactHash: string;
  builtAt: string;
}

/**
 * Go build result
 */
export interface GoBuildResult {
  success: boolean;
  cacheHit: boolean;
  artifactPath?: string;
  buildLog?: string;
  error?: string;
  duration: number;
}
