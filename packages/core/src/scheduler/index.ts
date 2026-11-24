/**
 * @vaultore/core - Scheduler
 *
 * BRICK-016: Basic scheduling (cron in frontmatter)
 */

import { CronExpressionParser } from "cron-parser";
import { ScheduledWorkflow, TimerHandle, Timers } from "../types";

export { classifyScheduleApproval } from "./approvals";
export type { ScheduleApproval, ScheduleApprovalState } from "./approvals";

export interface SchedulerOptions {
  /** Where the tick interval comes from: the platform's timers. */
  timers: Timers;
  tickIntervalMs?: number;
  onTick?: (workflows: DueWorkflow[]) => void;
}

/**
 * A workflow that came due, with the occurrence of its schedule that did: the
 * slot, which names this scheduled run in the schedule record (#255). It is
 * the time the cron expression gives, not when the tick noticed it, so two
 * runners that fire the same occurrence name the same slot.
 */
export interface DueWorkflow extends ScheduledWorkflow {
  slot: Date;
}

/** A note to keep armed, as a host's rescan finds it. */
export interface Registration {
  path: string;
  cronExpression: string;
}

export class WorkflowScheduler {
  private workflows = new Map<string, ScheduledWorkflow>();
  private interval: TimerHandle | null = null;
  private timers: Timers;
  private onTick?: (workflows: DueWorkflow[]) => void;
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

  /**
   * Arm exactly `registrations`: the ones armed already keep their next run,
   * as `register` keeps it, and the others are dropped. Returns those whose
   * cron expression is invalid, which are not armed, and those armed now that
   * were not before (or with another schedule), for the host to look for
   * missed runs of (#269).
   *
   * Unregistering everything and registering again recomputed every next run
   * from now, so a slot that came due between two ticks was dropped whenever
   * a rescan fell in between (#255).
   */
  replace(registrations: readonly Registration[]): { invalid: Registration[]; armed: Registration[] } {
    const wanted = new Set(registrations.map((entry) => entry.path));
    for (const path of this.workflows.keys()) {
      if (!wanted.has(path)) this.workflows.delete(path);
    }
    const invalid: Registration[] = [];
    const armed: Registration[] = [];
    for (const entry of registrations) {
      const before = this.workflows.get(entry.path);
      try {
        const now = this.register(entry.path, entry.cronExpression);
        if (now !== before) armed.push(entry);
      } catch {
        this.workflows.delete(entry.path);
        invalid.push(entry);
      }
    }
    return { invalid, armed };
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

  tick(): DueWorkflow[] {
    const now = new Date();
    const due: DueWorkflow[] = [];

    for (const workflow of this.workflows.values()) {
      if (!workflow.enabled) continue;
      if (workflow.nextRun <= now) {
        // A copy: the entry's nextRun moves on below, the slot does not.
        due.push({ ...workflow, slot: workflow.nextRun });
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
