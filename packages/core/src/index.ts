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
  ScheduledSlot,
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
  stripTrailing,
} from "./parser";

// =============================================================================
// EXECUTOR
// =============================================================================

export { WorkflowExecutor, DEFAULT_CONFIG_DIR, NoteChangedError, grantHash } from "./executor";
export { summarizeRun, runSucceeded, describeRun } from "./executor/run-summary";
export type { RunSummary } from "./executor/run-summary";

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

export {
  WorkflowScheduler,
  computeNextRun,
  lateAfterMs,
  MIN_LATE_AFTER_MS,
  MAX_LATE_AFTER_MS,
} from "./scheduler";

export type { DueWorkflow, Registration, ScheduleApproval } from "./scheduler";

export {
  GAP_MARGIN_MS,
  LATE_AFTER_MS,
  MAX_KEEP_DAYS,
  MissedSlotError,
  SlotTakenError,
  catchUpMissedSlot,
  claimSlot,
  dismissMissedSlots,
  isLateSlot,
  occurrencesBetween,
  recordMissedSlots,
  describeSlotState,
  keepMilliseconds,
  pruneSlotRecord,
  readSlotRecord,
  slotRecordDirectory,
} from "./scheduler/slot-record";
export {
  readMachineSettings,
  writeMachineSettings,
  machineSettingsPath,
  isLateAfterMinutes,
  MIN_LATE_AFTER_MINUTES,
  MAX_LATE_AFTER_MINUTES,
} from "./settings/machine-settings";
export type { MachineSettings, MachineSettingsOptions } from "./settings/machine-settings";
export { VaultStateStore, VaultStateStoreError, vaultKeyFor, isRecord, own } from "./settings/vault-state-store";
export type { VaultStateStoreSpec, VaultStateStoreOps } from "./settings/vault-state-store";
export {
  schedulesStore,
  schedulesPath,
  openSchedules,
  legacyApprovalsPath,
  noteScheduleState,
  approveNote,
  revokeNote,
  ownerName,
  SCHEDULES_FILE,
  SCHEDULE_OWNERS,
} from "./settings/schedules";
export type {
  NoteApproval,
  NoteScheduleState,
  OpenSchedulesOptions,
  ScheduleOwner,
  ScheduledNoteNow,
  SchedulesStoreOptions,
  VaultSchedules,
} from "./settings/schedules";
export { readDecisionDevice, deviceFilePath } from "./settings/device";
export type { DecisionDevice, DecisionDeviceOptions } from "./settings/device";

export type {
  ClaimSlotOptions,
  ReadSlotRecordOptions,
  RecordMissedOptions,
  RecordedGap,
  ResolveMissedOptions,
  SlotDecisionRecord,
  SlotMissedRecord,
  SlotResolutionRecord,
  SlotClaim,
  SlotClaimRecord,
  SlotEntry,
  SlotOutcome,
  SlotResult,
} from "./scheduler/slot-record";

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
// LOCKS
// =============================================================================

export {
  acquireLock,
  describeHolder,
  lastBootTime,
  LockHeldError,
  processIsAlive,
  readLockHolder,
  holderGoneBecause,
} from "./lock";

export { acquireAgentLock, agentStatus, agentLockPath, agentLockDirectory, AgentRunningError } from "./lock/agent-lock";
export type { AgentLockOptions, AgentStatus } from "./lock/agent-lock";

export type { LockHolder, LockOptions } from "./lock";

export {
  acquireRunLock,
  runLockDirectory,
  userStateDirectory,
  runLockPath,
  RunLockHeldError,
} from "./lock/run-lock";

export type { LeftBehind, RunLock, RunLockOptions } from "./lock/run-lock";

// =============================================================================
// ERRORS
// =============================================================================

export { errorMessage } from "./errors";

// =============================================================================
// VERSION
// =============================================================================

export { VERSION } from "./version";
