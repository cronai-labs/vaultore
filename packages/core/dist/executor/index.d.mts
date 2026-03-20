import { o as PlatformAdapter, f as Workflow } from '../index-DIxOf9vK.mjs';
import 'zod';

/**
 * @vaultore/core - Workflow Executor
 *
 * BRICK-004/005/006: Executes cells and persists outputs
 */

interface ExecuteOptions {
    platform: PlatformAdapter;
    workflowPath: string;
    content: string;
    targetCellId?: string;
    skipDependencies?: boolean;
    emitEvent?: (event: string, data?: unknown) => void;
}
declare class WorkflowExecutor {
    private parser;
    private serializer;
    private interpolator;
    runWorkflow(options: ExecuteOptions): Promise<Workflow>;
    private runCell;
}

export { type ExecuteOptions, WorkflowExecutor };
