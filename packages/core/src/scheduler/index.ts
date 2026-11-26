/**
 * @vaultore/core - Scheduler
 *
 * BRICK-016: Basic scheduling (cron in frontmatter)
 */

import { CronExpressionParser } from "cron-parser";
import { ScheduledWorkflow, TimerHandle, Timers } from "../types";

import { MAX_LATE_AFTER_MINUTES, MIN_LATE_AFTER_MINUTES } from "../settings/machine-settings";
export type { ScheduleApproval } from "./approvals";

export interface SchedulerOptions {
  /** Where the tick interval comes from: the platform's timers. */
  timers: Timers;
  tickIntervalMs?: number;
  onTick?: (workflows: DueWorkflow[]) => void;
  /** How late a slot may fire and still run (#269). Default LATE_AFTER_MS. */
  lateAfterMs?: number;
}

/**
 * A tick that fires a slot later than this does not run it: the slot is a
 * missed run (#269). The scheduler never lets a slot younger than this pass
 * unfired, so every occurrence is either fired in time or older than this,
 * and then part of a gap. A runner's setting may set it from MIN to MAX
 * (`lateAfterMs`); both runners read it from this machine's settings (`readMachineSettings`).
 */
export const LATE_AFTER_MS = 2 * 60 * 1000;
/** Two ticks of the 60-second scheduler: any less and a tick on time could find its slot late. */
export const MIN_LATE_AFTER_MS = MIN_LATE_AFTER_MINUTES * 60 * 1000;
export const MAX_LATE_AFTER_MS = MAX_LATE_AFTER_MINUTES * 60 * 1000;

/** `minutes` as the late threshold in ms, kept within its bounds; undefined is the default. */
export function lateAfterMs(minutes?: number): number {
  if (minutes === undefined || !Number.isFinite(minutes)) return LATE_AFTER_MS;
  return Math.min(Math.max(minutes * 60 * 1000, MIN_LATE_AFTER_MS), MAX_LATE_AFTER_MS);
}

/**
 * A workflow that came due, with the occurrence of its schedule that did: the
 * slot, which names this scheduled run in the schedule record (#255). It is
 * the time the cron expression gives, not when the tick noticed it, so two
 * runners that fire the same occurrence name the same slot.
 */
export interface DueWorkflow extends ScheduledWorkflow {
  slot: Date;
  /**
   * A later occurrence of the same note came due in this tick too (after an
   * arming or a late tick): only the latest runs, and the host records this
   * one as skipped rather than starting runs that would wait on each other.
   */
  superseded?: boolean;
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
  private lateAfter: number;

  constructor(options: SchedulerOptions) {
    this.timers = options.timers;
    this.tickIntervalMs = options.tickIntervalMs ?? 60 * 1000;
    this.onTick = options.onTick;
    this.lateAfter = options.lateAfterMs ?? LATE_AFTER_MS;
  }

  /** How late a slot may fire and still run; a runner's setting changes it at run time. */
  get lateAfterMs(): number {
    return this.lateAfter;
  }

  set lateAfterMs(ms: number) {
    this.lateAfter = ms;
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
    // From two minutes back: an occurrence that came due just before the note
    // was armed (a laptop opened at 09:01 for a 09:00 schedule) still fires,
    // in time; an older one is a missed run, which the host looks for.
    const now = Date.now();
    const nextRun = computeNextRun(cronExpression, new Date(now - this.lateAfter));
    const entry: ScheduledWorkflow = {
      path,
      cronExpression,
      nextRun,
      enabled: true,
      armedAt: new Date(now),
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
      // Every occurrence that is due, each its own slot: after a late tick or
      // an arming, those of the last two minutes fire together, and what lies
      // before them is a missed run. Bounded: a slot is never fired twice.
      let previous: DueWorkflow | undefined;
      while (workflow.nextRun <= now) {
        if (previous) previous.superseded = true;
        // A copy: the entry's nextRun moves on below, the slot does not.
        previous = { ...workflow, slot: workflow.nextRun };
        due.push(previous);
        workflow.lastRun = now;
        // The next occurrence after this slot, or after two minutes back when
        // the tick came late: nothing younger is skipped.
        const from = Math.max(workflow.nextRun.getTime(), now.getTime() - this.lateAfter);
        workflow.nextRun = computeNextRun(workflow.cronExpression, new Date(from));
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
