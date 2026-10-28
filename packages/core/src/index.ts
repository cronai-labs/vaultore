/**
 * @vaultore/core
 *
 * The core engine for VaultOre - a Markdown-native AI workflow engine.
 *
 * This package is editor-agnostic. Its adapters in this repository are the
 * Obsidian plugin (@vaultore/obsidian) and the CLI (@vaultore/cli).
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
  PlatformRequest,
  PlatformResponse,
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

  // Timer types
  TimerHandle,
  Timers,
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
  isWorkflowFrontmatter,
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

export { WorkflowExecutor, DEFAULT_CONFIG_DIR } from "./executor";

// =============================================================================
// RUNTIME
// =============================================================================

export { detectRuntimes, execContainer } from "./runtime";

// =============================================================================
// PROVIDERS
// =============================================================================

export {
  createProviderFromSettings,
  assertModelMatchesProvider,
  resolveProviderName,
  AI_PROVIDERS,
  DEFAULT_MODELS,
  DEFAULT_PROVIDER,
} from "./providers";

export type { AIProviderName } from "./providers";

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

export { resolveInVaultRoot } from "./vault/confine";

export type { VaultAPI, CellFn } from "./vault";

// =============================================================================
// ERRORS
// =============================================================================

export { errorMessage } from "./errors";

// =============================================================================
// VERSION
// =============================================================================

export { VERSION } from "./version";
