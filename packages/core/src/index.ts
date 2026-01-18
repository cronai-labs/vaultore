/**
 * @vaultore/core
 *
 * The core engine for VaultOre - a Markdown-native AI workflow engine.
 *
 * This package is editor-agnostic and can be used with:
 * - Obsidian (via @vaultore/obsidian)
 * - VS Code (via @vaultore/vscode)
 * - Zed (via @vaultore/zed)
 * - CLI (via @vaultore/cli)
 *
 * @packageDocumentation
 */

// =============================================================================
// TYPES
// =============================================================================

export type {
  // Permission types
  PermissionLevel,
  WorkflowPermissions,

  // Runtime types
  RuntimeEngine,
  RuntimeConfig,
  RuntimeDetection,
  ContainerExecOptions,
  ContainerExecResult,
  ContainerMount,

  // Workflow types
  GoConfig,
  WorkflowFrontmatter,
  Workflow,
  WorkflowExecution,

  // Cell types
  CellType,
  CellAttributes,
  Cell,
  OutputMeta,
  CellOutput,

  // Provider types
  ProviderConfig,
  CompletionRequest,
  CompletionResponse,
  AIProvider,

  // Scheduler types
  ScheduledWorkflow,

  // Platform types
  PlatformAdapter,
  ProgressHandle,

  // Event types
  CoreEvent,
  CoreEventListener,

  // DAG types
  DependencyNode,
  DependencyGraph,

  // Go cache types
  GoCacheEntry,
  GoBuildResult,
} from "./types";

export {
  DEFAULT_PERMISSIONS,
  DEFAULT_RUNTIME,
  DEFAULT_GO_CONFIG,
  WorkflowFrontmatterSchema,
} from "./types";

// =============================================================================
// PARSER
// =============================================================================

export {
  WorkflowParser,
  OutputSerializer,
  TemplateInterpolator,
  ParserError,
  parser,
  serializer,
  interpolator,
} from "./parser";

// =============================================================================
// EXECUTOR
// =============================================================================

export { WorkflowExecutor } from "./executor";

// =============================================================================
// RUNTIME
// =============================================================================

export { detectRuntimes, execContainer } from "./runtime";

// =============================================================================
// PROVIDERS
// =============================================================================

export { createProviderFromSettings } from "./providers";

// =============================================================================
// SCHEDULER
// =============================================================================

export { WorkflowScheduler, computeNextRun } from "./scheduler";

// =============================================================================
// VAULT API
// =============================================================================

export {
  createVaultAPI,
  createCellFn,
  generateRuntimeScript,
  VaultError,
} from "./vault";

export type { VaultAPI, CellFn } from "./vault";

// =============================================================================
// VERSION
// =============================================================================

export const VERSION = "0.1.0";
