import { S as ScheduledWorkflow } from '../index-DIxOf9vK.js';
import 'zod';

/**
 * @vaultore/core - Scheduler
 *
 * BRICK-016: Basic scheduling (cron in frontmatter)
 */

interface SchedulerOptions {
    tickIntervalMs?: number;
    onTick?: (workflows: ScheduledWorkflow[]) => void;
}
declare class WorkflowScheduler {
    private workflows;
    private interval;
    private onTick?;
    private tickIntervalMs;
    constructor(options?: SchedulerOptions);
    register(path: string, cronExpression: string): ScheduledWorkflow;
    unregister(path: string): void;
    list(): ScheduledWorkflow[];
    start(): void;
    stop(): void;
    tick(): ScheduledWorkflow[];
}
declare function computeNextRun(cronExpression: string, baseDate?: Date): Date;

export { type SchedulerOptions, WorkflowScheduler, computeNextRun };
