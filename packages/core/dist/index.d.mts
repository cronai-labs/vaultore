export { A as AIProvider, j as Cell, i as CellAttributes, k as CellOutput, h as CellType, m as CompletionRequest, n as CompletionResponse, C as ContainerExecOptions, c as ContainerExecResult, d as ContainerMount, q as CoreEvent, r as CoreEventListener, x as DEFAULT_GO_CONFIG, v as DEFAULT_PERMISSIONS, w as DEFAULT_RUNTIME, s as DependencyGraph, D as DependencyNode, u as GoBuildResult, t as GoCacheEntry, G as GoConfig, O as OutputMeta, P as PermissionLevel, o as PlatformAdapter, p as ProgressHandle, l as ProviderConfig, a as RuntimeConfig, b as RuntimeDetection, R as RuntimeEngine, S as ScheduledWorkflow, f as Workflow, g as WorkflowExecution, e as WorkflowFrontmatter, y as WorkflowFrontmatterSchema, W as WorkflowPermissions } from './index-DIxOf9vK.mjs';
export { OutputSerializer, ParserError, TemplateInterpolator, WorkflowParser, interpolator, parser, serializer } from './parser/index.mjs';
export { WorkflowExecutor } from './executor/index.mjs';
export { detectRuntimes, execContainer } from './runtime/index.mjs';
export { createProviderFromSettings } from './providers/index.mjs';
export { WorkflowScheduler, computeNextRun } from './scheduler/index.mjs';
export { CellFn, VaultAPI, VaultError, createCellFn, createVaultAPI, generateRuntimeScript } from './vault/index.mjs';
import 'zod';

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

declare const VERSION = "0.1.0";

export { VERSION };
