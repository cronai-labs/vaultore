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
  buildNetwork: "ask",
  vaultWrite: "deny",
  vaultRead: "allow",
};

// =============================================================================
// RUNTIME TYPES
// =============================================================================

/**
 * Available container runtime engines
 */
export type RuntimeEngine = "docker" | "podman" | "colima";

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
  timeout?: number;
  memoryLimit?: string;
  cpuLimit?: number;
  networkEnabled?: boolean;
  mounts?: ContainerMount[];
  stdin?: string;
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
export const WorkflowFrontmatterSchema = z.object({
  ore: z.literal(true),
  name: z.string(),
  version: z.string().optional(),
  author: z.string().optional(),
  tags: z.array(z.string()).optional(),
  description: z.string().optional(),
  runtime: z
    .object({
      engine: z.enum(["docker", "podman", "colima"]).optional(),
      image: z.string().optional(),
      timeout: z.number().optional(),
      memoryLimit: z.string().optional(),
      cpuLimit: z.number().optional(),
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
 * A cell's output (stored as HTML comment)
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

  // Settings
  getSetting<T>(key: string): T | undefined;
  setSetting<T>(key: string, value: T): Promise<void>;

  // Secrets
  getSecret(key: string): Promise<string | undefined>;
  setSecret(key: string, value: string): Promise<void>;
  deleteSecret(key: string): Promise<void>;

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
