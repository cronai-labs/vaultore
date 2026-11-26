/**
 * @vaultore/core - How a run went
 *
 * One summary of a finished run for both runners: the plugin's notice and the
 * last line of `vaultore run` (#290). Only the cells this run started count;
 * a workflow's outputs also carry results hydrated from earlier runs.
 */

import type { Cell, CellOutput } from "../types";

export interface RunSummary {
  /** Cells this run started, in the order they ran. */
  ran: string[];
  /** Cells that ran and did not succeed. */
  failed: string[];
  /**
   * Cells that did not run because a cell they depend on has no successful
   * output: it failed, in this run or an earlier one, or never ran.
   */
  blocked: string[];
}

/**
 * Sorts the cells this run started into failed and blocked. A cell is blocked
 * when one of its dependencies has no successful output, as the executor
 * decides before it runs a cell; any other cell that did not succeed failed.
 */
export function summarizeRun(
  cells: readonly Cell[],
  outputs: ReadonlyMap<string, CellOutput>,
  ran: readonly string[]
): RunSummary {
  const byId = new Map(cells.map((cell) => [cell.attributes.id, cell]));
  const failed: string[] = [];
  const blocked: string[] = [];
  for (const id of ran) {
    if (outputs.get(id)?.meta.status === "success") continue;
    const depends = byId.get(id)?.attributes.depends ?? [];
    const needsMissing = depends.some((dep) => outputs.get(dep)?.meta.status !== "success");
    (needsMissing ? blocked : failed).push(id);
  }
  return { ran: [...ran], failed, blocked };
}

/** Whether every cell the run started succeeded. */
export function runSucceeded(summary: RunSummary): boolean {
  return summary.failed.length === 0 && summary.blocked.length === 0;
}

/**
 * The run in one line, after the note's name: "daily completed", or
 * "daily finished, 1 of 3 cells failed (p), 1 did not run because a cell it
 * needs did not succeed (q)".
 */
export function describeRun(name: string, summary: RunSummary): string {
  if (runSucceeded(summary)) return `${name} completed`;
  const total = summary.ran.length;
  const parts: string[] = [];
  if (summary.failed.length > 0) {
    parts.push(
      `${summary.failed.length} of ${total} ${total === 1 ? "cell" : "cells"} failed (${summary.failed.join(", ")})`
    );
  }
  if (summary.blocked.length > 0) {
    const n = summary.blocked.length;
    parts.push(
      `${n}${summary.failed.length === 0 ? ` of ${total}` : ""} did not run because a cell ${n === 1 ? "it needs" : "they need"} did not succeed (${summary.blocked.join(", ")})`
    );
  }
  return `${name} finished, ${parts.join(", ")}`;
}
