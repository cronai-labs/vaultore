/**
 * @vaultore/core - Scheduler
 *
 * BRICK-016: Basic scheduling (cron in frontmatter)
 */

import { CronExpressionParser } from "cron-parser";
import { ScheduledWorkflow, TimerHandle, Timers } from "../types";

export interface SchedulerOptions {
  /** Where the tick interval comes from: the platform's timers. */
  timers: Timers;
  tickIntervalMs?: number;
  onTick?: (workflows: ScheduledWorkflow[]) => void;
}

export class WorkflowScheduler {
  private workflows = new Map<string, ScheduledWorkflow>();
  private interval: TimerHandle | null = null;
  private timers: Timers;
  private onTick?: (workflows: ScheduledWorkflow[]) => void;
  private tickIntervalMs: number;

  constructor(options: SchedulerOptions) {
    this.timers = options.timers;
    this.tickIntervalMs = options.tickIntervalMs ?? 60 * 1000;
    this.onTick = options.onTick;
  }

  /**
   * Register a workflow, or keep its entry when the cron is unchanged.
   * Re-registering with the same cron preserves nextRun and lastRun, so hosts
   * may refresh their registrations without pushing a due run back.
   */
  register(path: string, cronExpression: string): ScheduledWorkflow {
    const existing = this.workflows.get(path);
    if (existing && existing.cronExpression === cronExpression) {
      return existing;
    }
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
    if (this.interval !== null) return;
    this.interval = this.timers.setInterval(() => this.tick(), this.tickIntervalMs);
  }

  stop(): void {
    if (this.interval === null) return;
    this.timers.clearInterval(this.interval);
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
  const interval = CronExpressionParser.parse(cronExpression, { currentDate: baseDate });
  return interval.next().toDate();
}
