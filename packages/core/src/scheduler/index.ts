/**
 * @vaultore/core - Scheduler
 *
 * BRICK-016: Basic scheduling (cron in frontmatter)
 */

import cronParser from "cron-parser";
import { ScheduledWorkflow } from "../types";

export interface SchedulerOptions {
  tickIntervalMs?: number;
  onTick?: (workflows: ScheduledWorkflow[]) => void;
}

export class WorkflowScheduler {
  private workflows = new Map<string, ScheduledWorkflow>();
  private interval: NodeJS.Timeout | null = null;
  private onTick?: (workflows: ScheduledWorkflow[]) => void;
  private tickIntervalMs: number;

  constructor(options?: SchedulerOptions) {
    this.tickIntervalMs = options?.tickIntervalMs ?? 60 * 1000;
    this.onTick = options?.onTick;
  }

  register(path: string, cronExpression: string): ScheduledWorkflow {
    const nextRun = computeNextRun(cronExpression);
    const entry: ScheduledWorkflow = {
      path,
      cronExpression,
      nextRun,
      enabled: true,
    };
    this.workflows.set(path, entry);
    return entry;
  }

  unregister(path: string): void {
    this.workflows.delete(path);
  }

  list(): ScheduledWorkflow[] {
    return Array.from(this.workflows.values());
  }

  start(): void {
    if (this.interval) return;
    this.interval = setInterval(() => this.tick(), this.tickIntervalMs);
  }

  stop(): void {
    if (!this.interval) return;
    clearInterval(this.interval);
    this.interval = null;
  }

  tick(): ScheduledWorkflow[] {
    const now = new Date();
    const due: ScheduledWorkflow[] = [];

    for (const workflow of this.workflows.values()) {
      if (!workflow.enabled) continue;
      if (workflow.nextRun <= now) {
        due.push(workflow);
        workflow.lastRun = now;
        workflow.nextRun = computeNextRun(workflow.cronExpression, now);
      }
    }

    if (due.length > 0) {
      this.onTick?.(due);
    }

    return due;
  }
}

export function computeNextRun(
  cronExpression: string,
  baseDate: Date = new Date()
): Date {
  const interval = cronParser.parseExpression(cronExpression, { currentDate: baseDate });
  return interval.next().toDate();
}
