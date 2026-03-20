import { z } from 'zod';

/**
 * @vaultore/core - Type Definitions
 *
 * These types are the foundation of VaultOre. They define the shape of
 * workflows, cells, outputs, and the platform abstraction layer.
 *
 * @packageDocumentation
 */

/**
 * Permission levels for workflow capabilities
 */
type PermissionLevel = "allow" | "deny" | "ask";
/**
 * Workflow permissions defined in frontmatter
 */
interface WorkflowPermissions {
    /** Runtime network access */
    network: PermissionLevel;
    /** Build-time network (Go modules, pip) */
    buildNetwork: PermissionLevel;
    /** Write/create notes in vault */
    vaultWrite: PermissionLevel;
    /** Read notes from vault */
    vaultRead: PermissionLevel;
}
declare const DEFAULT_PERMISSIONS: WorkflowPermissions;
/**
 * Available container runtime engines
 */
type RuntimeEngine = "docker" | "podman" | "colima";
/**
 * Runtime configuration for workflow execution
 */
interface RuntimeConfig {
    engine: RuntimeEngine;
    image: string;
    timeout: number;
    memoryLimit: string;
    cpuLimit: number;
}
declare const DEFAULT_RUNTIME: RuntimeConfig;
/**
 * Container runtime detection result
 */
interface RuntimeDetection {
    available: RuntimeEngine[];
    preferred: RuntimeEngine | null;
    errors: Map<RuntimeEngine, string>;
}
/**
 * Container execution options
 */
interface ContainerExecOptions {
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
interface ContainerMount {
    source: string;
    target: string;
    readonly?: boolean;
}
/**
 * Container execution result
 */
interface ContainerExecResult {
    exitCode: number;
    stdout: string;
    stderr: string;
    duration: number;
}
/**
 * Go runtime configuration (v0.3+)
 */
interface GoConfig {
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
declare const DEFAULT_GO_CONFIG: GoConfig;
/**
 * Complete workflow frontmatter schema
 */
interface WorkflowFrontmatter {
    ore: true;
    name: string;
    version?: string;
    author?: string;
    tags?: string[];
    description?: string;
    runtime?: Partial<RuntimeConfig>;
    permissions?: Partial<WorkflowPermissions>;
    schedule?: string;
    go?: Partial<GoConfig>;
}
/**
 * Zod schema for validating frontmatter
 */
declare const WorkflowFrontmatterSchema: z.ZodObject<{
    ore: z.ZodLiteral<true>;
    name: z.ZodString;
    version: z.ZodOptional<z.ZodString>;
    author: z.ZodOptional<z.ZodString>;
    tags: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    description: z.ZodOptional<z.ZodString>;
    runtime: z.ZodOptional<z.ZodObject<{
        engine: z.ZodOptional<z.ZodEnum<["docker", "podman", "colima"]>>;
        image: z.ZodOptional<z.ZodString>;
        timeout: z.ZodOptional<z.ZodNumber>;
        memoryLimit: z.ZodOptional<z.ZodString>;
        cpuLimit: z.ZodOptional<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        engine?: "docker" | "podman" | "colima" | undefined;
        image?: string | undefined;
        timeout?: number | undefined;
        memoryLimit?: string | undefined;
        cpuLimit?: number | undefined;
    }, {
        engine?: "docker" | "podman" | "colima" | undefined;
        image?: string | undefined;
        timeout?: number | undefined;
        memoryLimit?: string | undefined;
        cpuLimit?: number | undefined;
    }>>;
    permissions: z.ZodOptional<z.ZodObject<{
        network: z.ZodOptional<z.ZodEnum<["allow", "deny", "ask"]>>;
        buildNetwork: z.ZodOptional<z.ZodEnum<["allow", "deny", "ask"]>>;
        vaultWrite: z.ZodOptional<z.ZodEnum<["allow", "deny", "ask"]>>;
        vaultRead: z.ZodOptional<z.ZodEnum<["allow", "deny", "ask"]>>;
    }, "strip", z.ZodTypeAny, {
        network?: "allow" | "deny" | "ask" | undefined;
        buildNetwork?: "allow" | "deny" | "ask" | undefined;
        vaultWrite?: "allow" | "deny" | "ask" | undefined;
        vaultRead?: "allow" | "deny" | "ask" | undefined;
    }, {
        network?: "allow" | "deny" | "ask" | undefined;
        buildNetwork?: "allow" | "deny" | "ask" | undefined;
        vaultWrite?: "allow" | "deny" | "ask" | undefined;
        vaultRead?: "allow" | "deny" | "ask" | undefined;
    }>>;
    schedule: z.ZodOptional<z.ZodString>;
    go: z.ZodOptional<z.ZodObject<{
        version: z.ZodOptional<z.ZodString>;
        builderImage: z.ZodOptional<z.ZodString>;
        cgo: z.ZodOptional<z.ZodUnion<[z.ZodLiteral<0>, z.ZodLiteral<1>]>>;
        tags: z.ZodOptional<z.ZodString>;
        ldflags: z.ZodOptional<z.ZodString>;
        cache: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodOptional<z.ZodBoolean>;
            dir: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            enabled?: boolean | undefined;
            dir?: string | undefined;
        }, {
            enabled?: boolean | undefined;
            dir?: string | undefined;
        }>>;
    }, "strip", z.ZodTypeAny, {
        version?: string | undefined;
        tags?: string | undefined;
        builderImage?: string | undefined;
        cgo?: 0 | 1 | undefined;
        ldflags?: string | undefined;
        cache?: {
            enabled?: boolean | undefined;
            dir?: string | undefined;
        } | undefined;
    }, {
        version?: string | undefined;
        tags?: string | undefined;
        builderImage?: string | undefined;
        cgo?: 0 | 1 | undefined;
        ldflags?: string | undefined;
        cache?: {
            enabled?: boolean | undefined;
            dir?: string | undefined;
        } | undefined;
    }>>;
}, "strip", z.ZodTypeAny, {
    ore: true;
    name: string;
    version?: string | undefined;
    author?: string | undefined;
    tags?: string[] | undefined;
    description?: string | undefined;
    runtime?: {
        engine?: "docker" | "podman" | "colima" | undefined;
        image?: string | undefined;
        timeout?: number | undefined;
        memoryLimit?: string | undefined;
        cpuLimit?: number | undefined;
    } | undefined;
    permissions?: {
        network?: "allow" | "deny" | "ask" | undefined;
        buildNetwork?: "allow" | "deny" | "ask" | undefined;
        vaultWrite?: "allow" | "deny" | "ask" | undefined;
        vaultRead?: "allow" | "deny" | "ask" | undefined;
    } | undefined;
    schedule?: string | undefined;
    go?: {
        version?: string | undefined;
        tags?: string | undefined;
        builderImage?: string | undefined;
        cgo?: 0 | 1 | undefined;
        ldflags?: string | undefined;
        cache?: {
            enabled?: boolean | undefined;
            dir?: string | undefined;
        } | undefined;
    } | undefined;
}, {
    ore: true;
    name: string;
    version?: string | undefined;
    author?: string | undefined;
    tags?: string[] | undefined;
    description?: string | undefined;
    runtime?: {
        engine?: "docker" | "podman" | "colima" | undefined;
        image?: string | undefined;
        timeout?: number | undefined;
        memoryLimit?: string | undefined;
        cpuLimit?: number | undefined;
    } | undefined;
    permissions?: {
        network?: "allow" | "deny" | "ask" | undefined;
        buildNetwork?: "allow" | "deny" | "ask" | undefined;
        vaultWrite?: "allow" | "deny" | "ask" | undefined;
        vaultRead?: "allow" | "deny" | "ask" | undefined;
    } | undefined;
    schedule?: string | undefined;
    go?: {
        version?: string | undefined;
        tags?: string | undefined;
        builderImage?: string | undefined;
        cgo?: 0 | 1 | undefined;
        ldflags?: string | undefined;
        cache?: {
            enabled?: boolean | undefined;
            dir?: string | undefined;
        } | undefined;
    } | undefined;
}>;
/**
 * Supported cell types
 */
type CellType = "ts" | "shell" | "ai" | "py" | "go";
/**
 * Cell attributes parsed from code fence
 */
interface CellAttributes {
    id: string;
    type: CellType;
    depends?: string[];
    timeout?: number;
    env?: Record<string, string>;
    model?: string;
    temperature?: number;
    maxTokens?: number;
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
interface Cell {
    attributes: CellAttributes;
    content: string;
    startLine: number;
    endLine: number;
    rawBlock: string;
}
/**
 * Output metadata stored with cell results
 */
interface OutputMeta {
    status: "success" | "error" | "timeout" | "cancelled";
    duration: number;
    timestamp: string;
    error?: string;
    cache?: "hit" | "miss";
    artifact?: string;
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
interface CellOutput {
    cellId: string;
    value: unknown;
    meta: OutputMeta;
}
/**
 * A complete parsed workflow
 */
interface Workflow {
    path: string;
    frontmatter: WorkflowFrontmatter;
    cells: Cell[];
    outputs: Map<string, CellOutput>;
    rawContent: string;
}
/**
 * Execution state for a running workflow
 */
interface WorkflowExecution {
    workflow: Workflow;
    currentCellIndex: number;
    startTime: Date;
    status: "running" | "completed" | "failed" | "cancelled";
    results: Map<string, CellOutput>;
}
/**
 * AI provider configuration
 */
interface ProviderConfig {
    apiKey: string;
    baseUrl?: string;
    defaultModel: string;
}
/**
 * AI completion request
 */
interface CompletionRequest {
    model: string;
    prompt: string;
    systemPrompt?: string;
    temperature?: number;
    maxTokens?: number;
}
/**
 * AI completion response
 */
interface CompletionResponse {
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
interface AIProvider {
    name: string;
    complete(request: CompletionRequest): Promise<CompletionResponse>;
    listModels?(): Promise<string[]>;
}
/**
 * Scheduled workflow entry
 */
interface ScheduledWorkflow {
    path: string;
    cronExpression: string;
    nextRun: Date;
    lastRun?: Date;
    lastStatus?: "success" | "error";
    enabled: boolean;
}
/**
 * Progress handle for long-running operations
 */
interface ProgressHandle {
    update(message: string, percent?: number): void;
    complete(): void;
}
/**
 * Platform adapter interface - implemented by each editor
 */
interface PlatformAdapter {
    readonly platform: "obsidian" | "vscode" | "zed" | "cli";
    readFile(path: string): Promise<string>;
    writeFile(path: string, content: string): Promise<void>;
    exists(path: string): Promise<boolean>;
    mkdirp(path: string): Promise<void>;
    listFiles(directory: string, pattern?: string): Promise<string[]>;
    readRaw?(path: string): Promise<string>;
    getVaultRoot(): Promise<string>;
    getSetting<T>(key: string): T | undefined;
    setSetting<T>(key: string, value: T): Promise<void>;
    getSecret(key: string): Promise<string | undefined>;
    setSecret(key: string, value: string): Promise<void>;
    deleteSecret(key: string): Promise<void>;
    showNotification?(message: string, type: "info" | "warning" | "error"): void;
    showProgress?(title: string): ProgressHandle;
    confirm?(message: string): Promise<boolean>;
    log(level: "debug" | "info" | "warn" | "error", message: string, data?: unknown): void;
}
/**
 * Events emitted by the core engine
 */
type CoreEvent = {
    type: "workflow:parsed";
    workflow: Workflow;
} | {
    type: "cell:started";
    cellId: string;
    workflow: string;
} | {
    type: "cell:output";
    cellId: string;
    output: CellOutput;
} | {
    type: "cell:completed";
    cellId: string;
    output: CellOutput;
} | {
    type: "cell:failed";
    cellId: string;
    error: string;
} | {
    type: "workflow:completed";
    workflow: string;
    results: Map<string, CellOutput>;
} | {
    type: "workflow:failed";
    workflow: string;
    error: string;
} | {
    type: "scheduler:tick";
    workflows: ScheduledWorkflow[];
} | {
    type: "scheduler:run";
    workflowPath: string;
} | {
    type: "permission:requested";
    permission: keyof WorkflowPermissions;
} | {
    type: "permission:granted";
    permission: keyof WorkflowPermissions;
    workflow: string;
} | {
    type: "permission:denied";
    permission: keyof WorkflowPermissions;
    workflow: string;
};
/**
 * Event listener type
 */
type CoreEventListener = (event: CoreEvent) => void;
/**
 * Cell dependency node in the DAG
 */
interface DependencyNode {
    cellId: string;
    dependencies: string[];
    dependents: string[];
    lastOutput?: CellOutput;
    isStale: boolean;
}
/**
 * Dependency graph for a workflow
 */
interface DependencyGraph {
    nodes: Map<string, DependencyNode>;
    executionOrder: string[];
    hasCycle: boolean;
    cycleNodes?: string[];
}
/**
 * Go build cache entry
 */
interface GoCacheEntry {
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
interface GoBuildResult {
    success: boolean;
    cacheHit: boolean;
    artifactPath?: string;
    buildLog?: string;
    error?: string;
    duration: number;
}

export { type AIProvider as A, type ContainerExecOptions as C, type DependencyNode as D, type GoConfig as G, type OutputMeta as O, type PermissionLevel as P, type RuntimeEngine as R, type ScheduledWorkflow as S, type WorkflowPermissions as W, type RuntimeConfig as a, type RuntimeDetection as b, type ContainerExecResult as c, type ContainerMount as d, type WorkflowFrontmatter as e, type Workflow as f, type WorkflowExecution as g, type CellType as h, type CellAttributes as i, type Cell as j, type CellOutput as k, type ProviderConfig as l, type CompletionRequest as m, type CompletionResponse as n, type PlatformAdapter as o, type ProgressHandle as p, type CoreEvent as q, type CoreEventListener as r, type DependencyGraph as s, type GoCacheEntry as t, type GoBuildResult as u, DEFAULT_PERMISSIONS as v, DEFAULT_RUNTIME as w, DEFAULT_GO_CONFIG as x, WorkflowFrontmatterSchema as y };
