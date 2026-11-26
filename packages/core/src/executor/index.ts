/**
 * @vaultore/core - Workflow Executor
 *
 * BRICK-004/005/006: Executes cells and persists outputs
 */

import { timingSafeEqual } from "node:crypto";
import {
  Cell,
  CellOutput,
  ContainerExecOptions,
  ContainerMount,
  OutputMeta,
  PlatformAdapter,
  RuntimeEngine,
  ScheduledSlot,
  Timers,
  Workflow,
  WorkflowFrontmatter,
  WorkflowPermissions,
  DEFAULT_PERMISSIONS,
  DEFAULT_RUNTIME,
} from "../types";
import { detectRuntimes, execContainer } from "../runtime";
import { errorMessage } from "../errors";
import { isRecord, vaultKeyFor } from "../settings/vault-state-store";
import type { RunnerDecisions } from "../settings/runner-decisions";
import {
  OutputSerializer,
  TemplateInterpolator,
  WorkflowParser,
  stripLeading,
  stripTrailing,
} from "../parser";
import {
  DEFAULT_MODELS,
  assertModelMatchesProvider,
  createProviderFromSettings,
  resolveProviderName,
} from "../providers";
import { renderArtifactIndex, renderOutputMarkdown } from "./output-note";
import { cellOutputsSource } from "../vault";
import { describeHolder } from "../lock";
import { RunLockHeldError } from "../lock/run-lock";
import type { LeftBehind } from "../lock/run-lock";
import type { SlotClaim, SlotOutcome } from "../scheduler/slot-record";
import { APPROVAL_PERMISSION_KEYS, approvalCovers, coveredPermissions } from "../settings/schedules";
import type { ApprovalBinding, NoteApproval, NotePermissions, ScheduledNoteNow } from "../settings/schedules";
import { parse } from "@babel/parser";

// =============================================================================
// EXECUTOR
// =============================================================================

export interface ExecuteOptions {
  platform: PlatformAdapter;
  workflowPath: string;
  content: string;
  targetCellId?: string;
  skipDependencies?: boolean;
  emitEvent?: (event: string, data?: unknown) => void;
  /**
   * The slot of a scheduled run. It is claimed before the run lock is taken,
   * and its outcome written when the run ends, so each slot of a schedule runs
   * at most once across the plugin and the CLI (#255). A run started by hand
   * passes none.
   */
  scheduled?: ScheduledSlot;
  /**
   * A slot the caller holds already: the catch-up of a missed gap (#269),
   * whose resolution took it. The run writes its outcome, as a scheduled run
   * does for its claim. Not together with `scheduled`.
   */
  slotClaim?: SlotClaim;
  /**
   * The note's schedule approval and its owner's binding: where a scheduled
   * run or a catch-up gets its permissions (#299). Required with `scheduled`
   * and `slotClaim`, refused without them. Nothing is asked, nothing stored.
   */
  unattended?: UnattendedApproval;
  /** Who runs it, for the run record: "Obsidian", "vaultore run", "vaultore agent". */
  runner?: string;
}

/** The approval an unattended run goes by. */
export interface UnattendedApproval {
  approval: NoteApproval;
  /** The binding of the approval's owner, whichever runner runs the note. */
  binding: ApprovalBinding;
}

/** How a run was started, as its `run.json` says (#299). */
export type RunTrigger =
  | { kind: "manual"; runner?: string }
  | {
      kind: "schedule" | "catch-up";
      runner?: string;
      /** The slot run, or the first slot of the gap caught up. */
      slot: string;
      /** The runner that owns the note, whose approval the run goes by. */
      owner: string;
      approvedAt: string;
    };

/** Where a permission of a run came from, as its `run.json` says. */
export interface PermissionLineage {
  value: "allow" | "deny";
  /**
   * `frontmatter`; `answer` given for this device, `at` when; `approval` an
   * answer given when the note was approved for schedule, `at` then;
   * `unanswered`: an `ask` nobody could answer, denied for this run.
   */
  source: "frontmatter" | "answer" | "approval" | "unanswered";
  at?: string;
}

/**
 * A scheduled or caught-up run whose approval does not cover the note as it
 * is: nothing ran, and its slot is recorded as skipped.
 */
export class UnattendedRunRefusedError extends Error {
  constructor(readonly workflowPath: string, why: string) {
    super(`${workflowPath} did not run unattended: ${why}`);
    this.name = "UnattendedRunRefusedError";
  }
}

/** The note changed after the caller read it; nothing was run. */
export class NoteChangedError extends Error {
  constructor(readonly workflowPath: string) {
    super(`${workflowPath} changed after it was read for this run, so nothing was run. Run it again`);
    this.name = "NoteChangedError";
  }
}

/** What a scheduled run came to, for its slot's outcome. */
function slotOutcomeOf(err: unknown): SlotOutcome {
  if (err instanceof RunLockHeldError || err instanceof NoteChangedError || err instanceof UnattendedRunRefusedError) {
    return { result: "skipped", reason: errorMessage(err) };
  }
  return { result: "failed", reason: errorMessage(err) };
}

export class WorkflowExecutor {
  private parser = new WorkflowParser();
  private serializer = new OutputSerializer();
  private interpolator = new TemplateInterpolator();

  async runWorkflow(options: ExecuteOptions): Promise<Workflow> {
    const held = options.slotClaim;
    if (!held) return this.runWorkflowOnce(options);
    // A slot held before the run starts is finished whatever ends it, also a
    // note that does not parse; finishing twice changes nothing.
    try {
      return await this.runWorkflowOnce(options);
    } catch (err) {
      await this.finishSlot(options.platform, options.workflowPath, held, slotOutcomeOf(err));
      throw err;
    }
  }

  private async runWorkflowOnce(options: ExecuteOptions): Promise<Workflow> {
    const workflow = this.parser.parse(options.content, options.workflowPath);
    // Before anything runs or is recorded: an id no cell has used to select
    // no cell, and the run was recorded as completed (#223). An empty id
    // counted as none given, and every cell ran.
    if (
      options.targetCellId !== undefined &&
      !workflow.cells.some((cell) => cell.attributes.id === options.targetCellId)
    ) {
      const ids = workflow.cells.map((cell) => cell.attributes.id).join(", ");
      throw new Error(
        `Cell "${options.targetCellId}" not found in ${workflow.path}. ` +
          (ids ? `Its cells are: ${ids}` : "It has no cells")
      );
    }
    const platform = confinedPlatform(options.platform);
    // Before any cell runs: the output is written back into this note, which
    // is refused when its path leads out of the vault through a link.
    const notePath = await platform.resolveInVault(workflow.path);

    // One run per scheduled slot (#255): claimed before the run lock, so a
    // runner that comes second to a slot is refused even when the first run
    // has ended. From here on the slot is spent, whatever the run comes to.
    if (options.scheduled && options.slotClaim) {
      throw new Error("A run either claims its scheduled slot or finishes one it holds, not both");
    }
    let claim: SlotClaim | undefined = options.slotClaim;
    if (options.scheduled) {
      if (typeof platform.claimSlot !== "function") {
        throw new Error(
          "This platform cannot claim a scheduled slot (it has no claimSlot), " +
            "so VaultOre does not run scheduled notes through it: another runner could run the same slot."
        );
      }
      claim = await platform.claimSlot(notePath, options.scheduled);
    }
    const report: RunReport = {};
    try {
      // After the claim, so that a refusal is recorded for the slot. Checked
      // against the content parsed here, which the run lock then holds to.
      const plan = await planRun(options, workflow, this.parser);
      const result = await this.runWithLock(options, platform, workflow, notePath, report, plan);
      await this.finishSlot(platform, workflow.path, claim, {
        result: report.status ?? "completed",
        ...(report.runId !== undefined ? { runId: report.runId } : {}),
      });
      return result;
    } catch (err) {
      const outcome = slotOutcomeOf(err);
      await this.finishSlot(platform, workflow.path, claim, {
        ...outcome,
        ...(report.status === "aborted" ? { result: "aborted" } : {}),
        ...(report.runId !== undefined ? { runId: report.runId } : {}),
      });
      throw err;
    }
  }

  /**
   * Writes a scheduled run's outcome. A write that fails must not replace the
   * run's own result or error: the slot then reads as abandoned once this
   * process is gone, and is not run again either way.
   */
  private async finishSlot(
    platform: PlatformAdapter,
    workflowPath: string,
    claim: SlotClaim | undefined,
    outcome: SlotOutcome
  ): Promise<void> {
    if (!claim) return;
    try {
      await claim.finish(outcome);
    } catch (err) {
      platform.log(
        "warn",
        `The outcome of the ${claim.slot.toISOString()} run of ${workflowPath} could not be recorded: ${errorMessage(err)}`
      );
    }
  }

  private async runWithLock(
    options: ExecuteOptions,
    platform: PlatformAdapter,
    workflow: Workflow,
    notePath: string,
    report: RunReport,
    plan: RunPlan
  ): Promise<Workflow> {
    // One run per note, across the plugin and the CLI (#215). Taken before
    // anything is recorded or run; a second runner is refused here, with the
    // holder named, and nothing of this run exists yet.
    const lock = await platform.acquireRunLock(notePath);
    try {
      // A lock left behind is a run of this note that ended without
      // finishing; its record still says "running" (#256).
      await finalizeAbandonedRuns(platform, workflow.path, lock.leftBehind);

      // Decided inside the lock: the caller read the note, and checked its
      // approval, before the lock was held. Another run may have written into
      // it since, or the user changed it; then what was checked is not what
      // would run.
      const current = await platform.readFile(workflow.path);
      if (current !== options.content) {
        throw new NoteChangedError(workflow.path);
      }
      return await this.runLocked(options, platform, workflow, report, plan);
    } finally {
      // However the run ended. A release that fails must not replace the
      // run's own result or error; the lock it leaves is taken over as stale
      // once this process is gone.
      try {
        await lock.release();
      } catch (err) {
        platform.log("warn", `The run lock of ${workflow.path} could not be released: ${errorMessage(err)}`);
      }
    }
  }

  private async runLocked(
    options: ExecuteOptions,
    platform: PlatformAdapter,
    workflow: Workflow,
    report: RunReport,
    plan: RunPlan
  ): Promise<Workflow> {
    const runContext = await createRunContext(platform, workflow.path, plan.trigger);
    report.runId = runContext.runId;

    const outputs = new Map<string, CellOutput>(workflow.outputs);
    let updatedContent = workflow.rawContent;

    // Cells this invocation ran, so the run record reflects the run rather than
    // every output hydrated from earlier ones.
    const ran: string[] = [];
    let runError: unknown;

    // Everything after the run record exists is inside the try. Setup can fail
    // too — an unavailable engine throws from ensureRuntimeAvailable — and that
    // failure used to escape before any finally, leaving the record this method
    // just wrote stuck at "running" forever.
    try {
      const { permissions, lineage } = await resolvePermissions(
        platform,
        workflow.path,
        workflow.frontmatter,
        await grantHash(workflow, this.parser),
        plan.unattended
      );
      runContext.permissions = lineage;

      const engineChoice = resolveEngine(
        workflow.frontmatter.runtime?.engine,
        platform.getSetting<string>("vaultore.runtimeEngine")
      );
      const runtime = {
        ...DEFAULT_RUNTIME,
        ...workflow.frontmatter.runtime,
        engine: engineChoice.engine,
      };

      await ensureRuntimeAvailable(engineChoice, platform.timers);

      const orderedCells = orderCells(workflow.cells);
      const cellsToRun = options.targetCellId !== undefined
        ? filterCellsForTarget(
            orderedCells,
            options.targetCellId,
            !options.skipDependencies
          )
        : orderedCells;
      await hydrateOutputsFromStubs(
        this.parser,
        platform,
        workflow.rawContent,
        outputs
      );

      for (const cell of cellsToRun) {
        options.emitEvent?.("cell:started", { cellId: cell.attributes.id });
        const result = await this.runCell({
          cell,
          platform: platform,
          permissions,
          outputs,
          runtime,
          runContext,
        });

        const outputPath = await persistCellOutput(
          platform,
          runContext,
          workflow.path,
          result
        );
        result.meta.runId = runContext.runId;
        result.meta.outputPath = outputPath;

        outputs.set(cell.attributes.id, result);
        ran.push(cell.attributes.id);

        updatedContent = await this.writeBackOutput(
          platform,
          workflow.path,
          updatedContent,
          result
        );
        options.emitEvent?.("cell:completed", { cellId: cell.attributes.id });
      }
    } catch (err) {
      // Captured so the record reflects it. Rethrown unchanged — finalising is
      // bookkeeping and must not alter what the caller sees.
      runError = err;
      throw err;
    } finally {
      report.status = await finalizeRunContext(platform, runContext, ran, outputs, runError);
    }

    return {
      ...workflow,
      outputs,
      rawContent: updatedContent,
    };
  }

  /**
   * Splice one cell's output into the note and persist it.
   *
   * The note is re-read first. A run holds a snapshot from before it started,
   * and writing that snapshot back discards anything the user typed while the
   * run was in flight — which is easy to hit, because the write happens once
   * per cell and container and AI cells are slow. `updateWorkflowOutput` is a
   * pure per-cell splice, so applying it to current content preserves those
   * edits and still lands the output in the right place.
   *
   * Returns the content now on disk, which becomes the fallback base if a later
   * re-read fails.
   */
  private async writeBackOutput(
    platform: PlatformAdapter,
    workflowPath: string,
    lastKnownContent: string,
    result: CellOutput
  ): Promise<string> {
    // A note deleted or renamed mid-run must not be recreated from the
    // snapshot: the platform's writeFile falls back to creating the file, which
    // would resurrect a note the user just deleted. The output is already
    // persisted under the run directory either way.
    if (!(await platform.exists(workflowPath))) {
      return lastKnownContent;
    }

    let base = lastKnownContent;
    try {
      base = await platform.readFile(workflowPath);
    } catch {
      // Unreadable but present: fall back to what we last wrote rather than
      // losing the output entirely.
    }

    const next = this.serializer.updateWorkflowOutput(base, result);
    await platform.writeFile(workflowPath, next);
    return next;
  }

  private async runCell(params: {
    cell: Cell;
    platform: PlatformAdapter;
    permissions: ResolvedPermissions;
    outputs: Map<string, CellOutput>;
    runtime: typeof DEFAULT_RUNTIME;
    runContext: RunContext;
  }): Promise<CellOutput> {
    const { cell, platform, permissions, outputs, runtime, runContext } = params;
    const start = Date.now();

    try {
      const deps = cell.attributes.depends ?? [];
      for (const dep of deps) {
        const depOutput = outputs.get(dep);
        if (!depOutput) {
          return buildOutput(
            cell.attributes.id,
            `Dependency output missing: ${dep}`,
            start,
            "error"
          );
        }
        if (depOutput.meta.status !== "success") {
          return buildOutput(
            cell.attributes.id,
            `Dependency failed: ${dep}`,
            start,
            "error"
          );
        }
      }

      if (cell.attributes.type === "ts") {
        const value = await executeTypeScriptCell(
          cell,
          platform,
          permissions,
          outputs,
          runtime,
          runContext
        );

        return buildOutput(cell.attributes.id, value, start);
      }

      if (cell.attributes.type === "shell") {
        const value = await executeShellCell(
          cell,
          platform,
          permissions,
          runtime,
          runContext
        );
        return buildOutput(cell.attributes.id, value, start);
      }

      if (cell.attributes.type === "ai") {
        const value = await executeAICell(
          cell,
          platform,
          permissions,
          outputs,
          this.interpolator
        );
        return buildOutput(cell.attributes.id, value, start);
      }

      return buildOutput(
        cell.attributes.id,
        unsupportedCellMessage(cell.attributes.id, cell.attributes.type),
        start,
        "error"
      );
    } catch (err) {
      const status = err instanceof CellTimeoutError ? "timeout" : "error";
      return buildOutput(cell.attributes.id, errorMessage(err), start, status);
    }
  }
}

/** The cell types this executor runs, in the order a message names them. */
export const RUNNABLE_CELL_TYPES = ["ts", "shell", "ai"] as const;

/**
 * What a user sees for a cell the parser accepts but VaultOre does not run
 * (`ore:py`, `ore:go`, which the Ore format reserves): what the cell is, what
 * runs instead, and what to do. Names no VaultOre version (#279).
 */
export function unsupportedCellMessage(id: string, type: string): string {
  const runnable = RUNNABLE_CELL_TYPES.map((t) => `ore:${t}`);
  const list = `${runnable.slice(0, -1).join(", ")} and ${runnable.at(-1)}`;
  return (
    `Cell "${id}" is an ore:${type} cell, which VaultOre does not run. ` +
    `It runs ${list} cells: rewrite the cell as one of those, or remove it. ` +
    `Cells that do not depend on it still run.`
  );
}

// =============================================================================
// EXECUTION HELPERS
// =============================================================================

/**
 * The platform as the executor uses it: every vault path it reads, writes,
 * tests or creates goes through `resolveInVault` first. Cells can plant
 * symbolic links through their mount, and the host follows them where the
 * container could not: a link to `~/.ssh` would otherwise let `vault.write`,
 * `{{note:}}`, the output files or the note's write-back reach outside the
 * vault. Paths that pass are used as resolved, so no link is followed again.
 */
function confinedPlatform(platform: PlatformAdapter): PlatformAdapter {
  if (typeof (platform as Partial<PlatformAdapter>).resolveInVault !== "function") {
    throw new Error(
      "This platform cannot check where a vault path leads (it has no resolveInVault), " +
        "so VaultOre does not read or write vault files through it."
    );
  }
  if (typeof (platform as Partial<PlatformAdapter>).acquireRunLock !== "function") {
    throw new Error(
      "This platform cannot lock a note for a run (it has no acquireRunLock), " +
        "so VaultOre does not run notes through it: another runner could run the same note at once."
    );
  }
  const resolve = (path: string) => platform.resolveInVault(path.replace(/^[\\/]+/, ""));
  const confined: Partial<PlatformAdapter> = {
    readFile: async (path) => platform.readFile(await resolve(path)),
    writeFile: async (path, content) => platform.writeFile(await resolve(path), content),
    exists: async (path) => platform.exists(await resolve(path)),
    mkdirp: async (path) => platform.mkdirp(await resolve(path)),
  };
  return new Proxy(platform, {
    get(target, prop) {
      if (typeof prop === "string" && prop in confined) {
        return confined[prop as keyof typeof confined];
      }
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

interface ResolvedPermissions {
  network: boolean;
  buildNetwork: boolean;
  vaultRead: boolean;
  vaultWrite: boolean;
}

/** How a run ended, as its `run.json` says. */
type RunStatus = "completed" | "failed" | "aborted";

/** What the locked run tells the slot's outcome: its id, once it has one, and how it ended. */
interface RunReport {
  runId?: string;
  status?: RunStatus;
}

interface RunContext {
  runId: string;
  runDir: string;
  runBaseDir: string;
  startedAt: string;
  workflowPath: string;
  outputRoot: string;
  trigger: RunTrigger;
  /** Each permission's value and source, once resolved. */
  permissions?: Record<string, PermissionLineage>;
}

/** What a run goes by, decided before anything runs. */
interface RunPlan {
  trigger: RunTrigger;
  /** An unattended run's permissions, from its approval. */
  unattended?: { approval: NoteApproval; permissions: NonNullable<ReturnType<typeof coveredPermissions>> };
}

/** The frontmatter's permissions, defaults filled in. */
export function notePermissions(frontmatter: WorkflowFrontmatter): NotePermissions {
  const merged: WorkflowPermissions = { ...DEFAULT_PERMISSIONS, ...frontmatter.permissions };
  return Object.fromEntries(APPROVAL_PERMISSION_KEYS.map((key) => [key, merged[key]])) as NotePermissions;
}

/** A workflow with a schedule as an approval sees it; undefined for one without a schedule. */
export async function scheduledNoteOf(
  workflow: Workflow,
  parser: WorkflowParser = new WorkflowParser()
): Promise<ScheduledNoteNow | undefined> {
  const schedule = workflow.frontmatter.schedule;
  if (!schedule) return undefined;
  return {
    path: workflow.path,
    schedule: String(schedule),
    hash: await grantHash(workflow, parser),
    permissions: notePermissions(workflow.frontmatter),
  };
}

/**
 * The trigger of a run, and for a scheduled run or a catch-up the
 * permissions its approval holds for the note as parsed (#299). Refused with
 * `UnattendedRunRefusedError` when there is no approval, or it does not
 * cover the note; and for an approval given with a run started by hand.
 */
async function planRun(options: ExecuteOptions, workflow: Workflow, parser: WorkflowParser): Promise<RunPlan> {
  const runner = options.runner !== undefined ? { runner: options.runner } : {};
  const slot = options.scheduled?.slot ?? options.slotClaim?.slot;
  if (slot === undefined) {
    if (options.unattended) throw new Error("An approval is for a scheduled run or a catch-up, not for a run started by hand");
    return { trigger: { kind: "manual", ...runner } };
  }
  const { unattended } = options;
  if (!unattended) {
    throw new UnattendedRunRefusedError(workflow.path, "it is not approved to run on schedule on this computer");
  }
  const note = await scheduledNoteOf(workflow, parser);
  if (note === undefined) throw new UnattendedRunRefusedError(workflow.path, "it has no schedule");
  const permissions = coveredPermissions(unattended.approval, note);
  if (!approvalCovers(unattended.approval, note, unattended.binding) || permissions === undefined) {
    throw new UnattendedRunRefusedError(
      workflow.path,
      `it changed since it was approved on ${unattended.approval.approvedAt}; approve it again`
    );
  }
  return {
    trigger: {
      kind: options.scheduled ? "schedule" : "catch-up",
      ...runner,
      slot: slot.toISOString(),
      owner: unattended.approval.owner,
      approvedAt: unattended.approval.approvedAt,
    },
    unattended: { approval: unattended.approval, permissions },
  };
}

/**
 * A stored decision, bound to the content it was given for (permissions-spec
 * §5.3). Before #284, one per note, under `vaultore.permissionDecisions`;
 * that key is still read when decisions from other devices apply, and never
 * written, so an older runner elsewhere keeps its own.
 */
type StoredDecision = Partial<WorkflowPermissions> & {
  workflowHash?: string;
  grantedAt?: string;
};

/**
 * A decision bound to the device it was made on as well (#284): kept under
 * `vaultore.deviceDecisions`, per note and then per device id, so that two
 * computers sharing a vault each keep their own. `mac` covers the vault, the
 * note, the device, the content hash and the answers.
 */
type DeviceDecision = StoredDecision & { mac?: string };
type DeviceDecisions = Record<string, Record<string, DeviceDecision>>;

const PERMISSION_KEYS = ["network", "buildNetwork", "vaultRead", "vaultWrite"] as const;

/** What a decision's MAC is made over, in one canonical text. */
function decisionText(vault: string, path: string, device: string, decision: StoredDecision): string {
  const answers = Object.fromEntries(PERMISSION_KEYS.map((key) => [key, decision[key] ?? null]));
  return canonicalJson({
    format: "vaultore.permission-decision",
    version: 1,
    vault,
    path,
    device,
    workflowHash: decision.workflowHash ?? null,
    grantedAt: decision.grantedAt ?? null,
    answers,
  });
}

function sameMac(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Several decisions as one, per permission: a deny in any of them wins over
 * an allow. Undefined when there are none.
 */
function strictest(decisions: StoredDecision[]): StoredDecision | undefined {
  if (decisions.length === 0) return undefined;
  const merged: StoredDecision = {};
  for (const key of PERMISSION_KEYS) {
    const answers = decisions.map((decision) => decision[key]);
    if (answers.includes("deny")) merged[key] = "deny";
    else if (answers.includes("allow")) merged[key] = "allow";
  }
  return merged;
}

/** An own property only, from a record read out of a file. */
function ownEntry<T>(record: unknown, key: string): T | undefined {
  if (typeof record !== "object" || record === null) return undefined;
  return Object.prototype.hasOwnProperty.call(record, key) ? (record as Record<string, T>)[key] : undefined;
}

/**
 * What a permission decision is bound to: the frontmatter as written (keys
 * the schema drops included) and each cell's attributes and source. Line
 * numbers and output stubs are left out — the executor rewrites outputs into
 * the note after every cell, so they change on every run.
 *
 * Exported because a schedule approval is bound to the same hash
 * (scheduler/approvals.ts): consent given for one content of a note.
 */
export async function grantHash(
  workflow: Workflow,
  parser: WorkflowParser = new WorkflowParser()
): Promise<string> {
  const fingerprint = canonicalJson({
    frontmatter: parser.parseRawFrontmatter(workflow.rawContent) ?? null,
    cells: workflow.cells.map((cell) => ({
      attributes: cell.attributes,
      content: cell.content,
    })),
  });
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(fingerprint)
  );
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
}

/** JSON with object keys sorted, so key order in the note does not matter. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0
          )
        )
      : v
  );
}

async function resolvePermissions(
  platform: PlatformAdapter,
  workflowPath: string,
  frontmatter: WorkflowFrontmatter,
  workflowHash: string,
  unattended?: RunPlan["unattended"]
): Promise<{ permissions: ResolvedPermissions; lineage: Record<string, PermissionLineage> }> {
  const merged: WorkflowPermissions = {
    ...DEFAULT_PERMISSIONS,
    ...frontmatter.permissions,
  };
  const lineage: Record<string, PermissionLineage> = {};

  // Unattended (#299): what the approval holds, checked against the note
  // before the run; nobody is asked, nothing is stored, and the answers kept
  // for runs started by hand are not read.
  if (unattended) {
    for (const key of PERMISSION_KEYS) {
      const held = unattended.permissions[key];
      lineage[key] =
        held.source === "answer"
          ? { value: held.value, source: "approval", at: unattended.approval.approvedAt }
          : { value: held.value, source: "frontmatter" };
    }
    return { permissions: grantedBy(lineage), lineage };
  }

  const resolved: WorkflowPermissions = { ...merged };
  const asked = PERMISSION_KEYS.filter((key) => merged[key] === "ask");
  for (const key of PERMISSION_KEYS) {
    if (merged[key] !== "ask") lineage[key] = { value: merged[key] === "allow" ? "allow" : "deny", source: "frontmatter" };
  }

  // Only an `ask` is answered and stored. A note that asks nothing needs no
  // device and leaves the stored decisions as they are.
  if (asked.length > 0) {
    const device = await platform.decisionDevice();
    // The vault's real path, so that a vault opened through a symbolic link
    // is the same vault, as for the run locks and the approvals.
    const vault = await vaultKeyFor(await platform.getVaultRoot());
    // Read out of a file anyone who can write the vault can change: anything
    // that is not a record is no decision.
    const storedValue = platform.getSetting<unknown>("vaultore.deviceDecisions");
    const stored: DeviceDecisions = isRecord(storedValue) ? (storedValue as DeviceDecisions) : {};
    const noteValue = ownEntry<unknown>(stored, workflowPath);
    const forNote: Record<string, DeviceDecision> = isRecord(noteValue) ? (noteValue as Record<string, DeviceDecision>) : {};

    // The other runner on this computer shares the device, so its answers
    // count as well (#299). It keeps them in its own file, which it alone
    // writes; one that cannot be read is no answers, and the log says so.
    let other: RunnerDecisions | undefined;
    try {
      other = await platform.otherRunnerDecisions();
    } catch (err) {
      platform.log("warn", `${errorMessage(err)}; answers kept there do not apply to this run`);
    }
    const otherNoteValue = ownEntry<unknown>(other?.decisions, workflowPath);
    const otherForNote: Record<string, unknown> = isRecord(otherNoteValue) ? otherNoteValue : {};

    // A decision applies only to the content it was given for (#69), and
    // only on the device that made it (#284): one whose MAC does not verify
    // was not made here, or was changed since, and counts as undecided.
    // Undefined for no entry, false for one that does not verify (as after
    // the vault was moved: the MAC is over its path).
    const verified = (value: unknown): DeviceDecision | false | undefined => {
      if (value === undefined) return undefined;
      const decision = isRecord(value) ? (value as DeviceDecision) : undefined;
      const expected = decision === undefined ? "" : device.sign(decisionText(vault, workflowPath, device.id, decision));
      return decision !== undefined && typeof decision.mac === "string" && sameMac(decision.mac, expected) ? decision : false;
    };
    const mineChecked = verified(ownEntry<unknown>(forNote, device.id));
    const theirsChecked = verified(ownEntry<unknown>(otherForNote, device.id));
    const mine = mineChecked || undefined;
    const theirs = theirsChecked || undefined;
    // This device's answers in both files, a deny winning where they differ.
    const thisDevice = [mine, theirs].filter((decision): decision is DeviceDecision => decision?.workflowHash === workflowHash);
    let current: StoredDecision | undefined = thisDevice.length === 1 && thisDevice[0] === mine ? mine : strictest(thisDevice);
    // Whether the answers are this device's to keep: given now, or taken over
    // from another device. An answer read from the other runner's file is
    // left there, not copied.
    let keep = false;
    // Turned on in this machine's settings, never by the vault: decisions
    // made on other devices, and one stored before decisions carried a
    // device, apply too. Where they disagree, a deny wins, whatever order
    // the file lists them in.
    const elsewhere = strictest(
      [
        ...[...Object.entries(forNote), ...Object.entries(otherForNote)]
          .filter(([id]) => id !== device.id)
          .map(([, decision]) => decision),
        ownEntry<unknown>(platform.getSetting("vaultore.permissionDecisions"), workflowPath),
      ].filter(
        (decision): decision is StoredDecision => isRecord(decision) && decision["workflowHash"] === workflowHash
      )
    );
    if (current === undefined && elsewhere !== undefined && device.acceptOtherDevices) {
      current = elsewhere;
      keep = true;
    }
    // An entry that does not verify is said once it is known whether an
    // answer applies anyway. This runner's own is then replaced, so that it
    // is not said again on every run; the other runner's is its to replace,
    // and is said only when it leaves the run to ask.
    if (mineChecked === false) {
      if (current !== undefined) keep = true;
      platform.log(
        "warn",
        `The stored permission decision for ${workflowPath} was not made here or was changed; ` +
          (current !== undefined ? "replaced by this device's answer" : "asking again")
      );
    }
    if (theirsChecked === false && current === undefined) {
      platform.log(
        "warn",
        `The other runner's (${other?.file ?? ""}) permission decision for ${workflowPath} was not made here or was changed; asking again`
      );
    }
    if (current === undefined && elsewhere !== undefined) {
      // Said once per run, so that an upgrade that asks again is explained.
      platform.log(
        "info",
        `An answer for ${workflowPath} given on another device, or before answers were kept per device, does not apply here; ` +
          "asking again. Permission answers from other devices (vaultore permissions other-devices) changes that"
      );
    }

    // The answers to keep: given now, or kept before. A permission nobody
    // could be asked about is denied for this run only, so that a later run
    // that can ask (the CLI with --yes) is not bound by a deny nobody gave.
    const answered: (typeof PERMISSION_KEYS)[number][] = [];
    for (const key of asked) {
      const answer = current?.[key];
      if (answer === "allow" || answer === "deny") {
        resolved[key] = answer;
        answered.push(key);
        lineage[key] = { value: answer, source: "answer", ...(current?.grantedAt !== undefined ? { at: current.grantedAt } : {}) };
        continue;
      }
      const approved = platform.confirm
        ? await platform.confirm(`VaultOre permission request: ${key} for ${workflowPath}. Allow?`)
        : undefined;
      resolved[key] = approved === true ? "allow" : "deny";
      if (approved === undefined) {
        platform.log("warn", `${key} for ${workflowPath} is denied for this run: nobody could be asked, and nothing was kept`);
        lineage[key] = { value: "deny", source: "unanswered" };
        continue;
      }
      answered.push(key);
      lineage[key] = { value: resolved[key] === "allow" ? "allow" : "deny", source: "answer", at: new Date().toISOString() };
      keep = true;
    }

    const decision: StoredDecision = {
      ...Object.fromEntries(answered.map((key) => [key, resolved[key]])),
      workflowHash,
      grantedAt: (current === mine ? mine?.grantedAt : undefined) ?? new Date().toISOString(),
    };
    const entry: DeviceDecision = { ...decision, mac: device.sign(decisionText(vault, workflowPath, device.id, decision)) };
    // Without a prototype, so that a note path such as "__proto__" is an
    // entry like any other.
    const nextForNote = Object.assign(Object.create(null) as Record<string, DeviceDecision>, forNote);
    nextForNote[device.id] = entry;
    const next = Object.assign(Object.create(null) as DeviceDecisions, stored);
    next[workflowPath] = nextForNote;
    if (keep && answered.length > 0 && JSON.stringify(mine) !== JSON.stringify(entry)) {
      await platform.setSetting("vaultore.deviceDecisions", next);
    }
  }

  return { permissions: grantedBy(lineage), lineage };
}

/** What a run may do, from each permission's value. */
function grantedBy(lineage: Record<string, PermissionLineage>): ResolvedPermissions {
  return {
    network: lineage["network"]?.value === "allow",
    buildNetwork: lineage["buildNetwork"]?.value === "allow",
    vaultRead: lineage["vaultRead"]?.value === "allow",
    vaultWrite: lineage["vaultWrite"]?.value === "allow",
  };
}

/**
 * Where the engine came from. A workflow note that names an engine wins over
 * the user's configured default, so when it fails the message has to say which
 * source asked for it — otherwise "docker not available" is baffling to someone
 * who selected colima in settings.
 */
export interface EngineChoice {
  engine: RuntimeEngine;
  source: "workflow" | "setting" | "default";
  /** The user's configured default, when they have one and it is not what ran. */
  configuredDefault?: RuntimeEngine;
}

export function resolveEngine(
  frontmatterEngine: string | undefined,
  settingEngine: string | undefined
): EngineChoice {
  const configuredDefault = settingEngine as RuntimeEngine | undefined;

  if (frontmatterEngine) {
    return {
      engine: frontmatterEngine as RuntimeEngine,
      source: "workflow",
      ...(configuredDefault && configuredDefault !== frontmatterEngine
        ? { configuredDefault }
        : {}),
    };
  }

  if (settingEngine) {
    return { engine: settingEngine as RuntimeEngine, source: "setting" };
  }

  return { engine: DEFAULT_RUNTIME.engine, source: "default" };
}

export function describeEngineFailure(
  choice: EngineChoice,
  detail: string,
  available: readonly RuntimeEngine[]
): string {
  const lines = [`Container runtime "${choice.engine}" is not available: ${detail}`];

  if (choice.source === "workflow") {
    lines.push(`This workflow's frontmatter requests "${choice.engine}".`);
    if (choice.configuredDefault) {
      lines.push(
        `Your configured default is "${choice.configuredDefault}", but frontmatter takes precedence.`,
        `Remove "engine: ${choice.engine}" from the note to use your default, or start ${choice.engine}.`
      );
    }
  } else if (choice.source === "setting") {
    lines.push(`"${choice.engine}" is your configured default in VaultOre settings.`);
  }

  lines.push(
    available.length > 0
      ? `Detected on this machine: ${available.join(", ")}.`
      : "No container runtime was detected on this machine."
  );

  return lines.join("\n");
}

async function ensureRuntimeAvailable(choice: EngineChoice, timers: Timers): Promise<void> {
  const detection = await detectRuntimes(timers);
  if (detection.available.includes(choice.engine)) return;

  const detail = detection.errors.get(choice.engine) ?? "runtime not available";
  throw new Error(describeEngineFailure(choice, detail, detection.available));
}

export function orderCells(cells: Cell[]): Cell[] {
  const byId = new Map<string, Cell>();
  const deps = new Map<string, Set<string>>();
  const dependents = new Map<string, Set<string>>();

  for (const cell of cells) {
    byId.set(cell.attributes.id, cell);
    deps.set(cell.attributes.id, new Set(cell.attributes.depends ?? []));
    dependents.set(cell.attributes.id, new Set());
  }

  for (const cell of cells) {
    for (const dep of cell.attributes.depends ?? []) {
      dependents.get(dep)?.add(cell.attributes.id);
    }
  }

  const ready = Array.from(deps.entries())
    .filter(([, depsSet]) => depsSet.size === 0)
    .map(([id]) => id);

  const ordered: Cell[] = [];

  while (ready.length > 0) {
    const id = ready.shift();
    if (!id) break;
    const cell = byId.get(id);
    if (cell) ordered.push(cell);

    for (const dep of dependents.get(id) ?? []) {
      const set = deps.get(dep);
      if (!set) continue;
      set.delete(id);
      if (set.size === 0) ready.push(dep);
    }
  }

  if (ordered.length !== cells.length) {
    // The parser refuses a cycle and an unknown dependency, so this is not
    // reachable from a note. Document order is no answer for cells that have
    // none: it ran each one against whatever an earlier run left behind.
    const placed = new Set(ordered);
    const stuck = cells.filter((cell) => !placed.has(cell)).map((cell) => cell.attributes.id);
    throw new Error(
      `Cells cannot be ordered, their dependencies never complete: ${stuck.join(", ")}`
    );
  }

  return ordered;
}

function filterCellsForTarget(
  cells: Cell[],
  targetId: string,
  includeDependencies = true
): Cell[] {
  if (!includeDependencies) {
    return cells.filter((cell) => cell.attributes.id === targetId);
  }

  const byId = new Map(cells.map((cell) => [cell.attributes.id, cell]));
  const result: Cell[] = [];
  const visited = new Set<string>();

  function visit(id: string) {
    if (visited.has(id)) return;
    visited.add(id);
    const cell = byId.get(id);
    if (!cell) return;
    for (const dep of cell.attributes.depends ?? []) {
      visit(dep);
    }
    result.push(cell);
  }

  visit(targetId);

  const orderedIds = new Set(result.map((cell) => cell.attributes.id));
  return cells.filter((cell) => orderedIds.has(cell.attributes.id));
}

/** A container cell ran past its timeout; its output gets status "timeout". */
class CellTimeoutError extends Error {
  constructor(type: "ts" | "shell", timeoutMs: number | undefined) {
    super(`${type} cell timed out after ${(timeoutMs ?? 0) / 1000}s`);
    this.name = "CellTimeoutError";
  }
}

function buildOutput(
  cellId: string,
  value: unknown,
  start: number,
  status: OutputMeta["status"] = "success"
): CellOutput {
  return {
    cellId,
    value,
    meta: {
      status,
      duration: Date.now() - start,
      timestamp: new Date().toISOString(),
      error: status === "success" ? undefined : String(value),
    },
  };
}

async function createRunContext(
  platform: PlatformAdapter,
  workflowPath: string,
  trigger: RunTrigger
): Promise<RunContext> {
  const startedAt = new Date().toISOString();
  const runId = createRunId();
  const outputRootSetting = platform.getSetting<string>("vaultore.outputRoot");
  const outputRoot = normalizeOutputRoot(outputRootSetting);
  const runBaseDir = runBasePath(outputRoot, workflowPath);
  const runDir = `${runBaseDir}/${runId}`;

  await platform.mkdirp(runDir);
  await platform.writeFile(
    `${runDir}/run.json`,
    JSON.stringify(
      {
        runId,
        workflowPath,
        startedAt,
        status: "running",
        trigger,
      },
      null,
      2
    )
  );

  return { runId, runDir, runBaseDir, startedAt, workflowPath, outputRoot, trigger };
}

/**
 * Close out run.json with a terminal status and a per-cell summary.
 *
 * Best effort: a failure to write the record must not mask whatever error is
 * already propagating out of the run.
 */
/**
 * Marks the records of runs that ended without finishing as `aborted`. A run
 * whose process was killed, or whose window was reloaded, never reached its
 * `finally`, so its `run.json` says "running" for good. Its run lock stayed
 * behind, and the run that took it over passes its holders here.
 *
 * Only records this note's runs left, still "running", and started at or after
 * the holder took the lock are touched: while it held the lock, no other run of
 * the note could start one. Records of other runs, finished or not, are left
 * alone. Failures are logged, never thrown: the run that took over goes ahead.
 */
export async function finalizeAbandonedRuns(
  platform: PlatformAdapter,
  workflowPath: string,
  leftBehind: readonly LeftBehind[]
): Promise<void> {
  if (leftBehind.length === 0) return;
  const outputRoot = normalizeOutputRoot(platform.getSetting<string>("vaultore.outputRoot"));
  const runBaseDir = runBasePath(outputRoot, workflowPath);
  let records: string[];
  try {
    if (!(await platform.exists(runBaseDir))) return;
    records = (await platform.listFiles(runBaseDir, "run.json")).filter(
      (path) => path.startsWith(`${runBaseDir}/`) && path.endsWith("/run.json")
    );
  } catch (err) {
    platform.log("warn", `The run records of ${workflowPath} could not be listed: ${errorMessage(err)}`);
    return;
  }

  const now = new Date().toISOString();
  for (const path of records) {
    try {
      const record: unknown = JSON.parse(await platform.readFile(path));
      if (typeof record !== "object" || record === null) continue;
      const { status, startedAt, workflowPath: recorded } = record as Record<string, unknown>;
      if (status !== "running" || recorded !== workflowPath || typeof startedAt !== "string") continue;
      const started = Date.parse(startedAt);
      const owner = leftBehind.find(({ holder }) => {
        const since = Date.parse(holder.since);
        return Number.isFinite(started) && Number.isFinite(since) && started >= since;
      });
      if (!owner) continue;
      const { holder, why } = owner;
      await platform.writeFile(
        path,
        JSON.stringify(
          {
            ...record,
            status: "aborted",
            error:
              `The run ended without finishing: ${describeHolder(holder)}, which took the note's run lock at ${holder.since}, ${why}. ` +
              `Recorded at ${now}, when the next run took the lock over`,
          },
          null,
          2
        )
      );
      platform.log("info", `Marked the run ${path} as aborted: it ended without finishing`);
    } catch (err) {
      platform.log("warn", `The run record ${path} could not be finalised: ${errorMessage(err)}`);
    }
  }
}

export async function finalizeRunContext(
  platform: PlatformAdapter,
  runContext: RunContext,
  ran: readonly string[],
  outputs: ReadonlyMap<string, CellOutput>,
  runError?: unknown
): Promise<RunStatus> {
  const cells = ran.map((cellId) => ({
    cellId,
    status: outputs.get(cellId)?.meta.status ?? "error",
    durationMs: outputs.get(cellId)?.meta.duration,
  }));

  const failed = cells.filter((c) => c.status !== "success").length;
  const finishedAt = new Date().toISOString();
  const startedMs = Date.parse(runContext.startedAt);

  // An error that escaped the run is authoritative. `ran` only holds cells that
  // were persisted, so a throw part-way through leaves the recorded cells all
  // green — reporting that as "completed" would claim success for a run the
  // caller saw fail.
  const status: RunStatus = runError !== undefined ? "aborted" : failed > 0 ? "failed" : "completed";

  try {
    await platform.writeFile(
      `${runContext.runDir}/run.json`,
      JSON.stringify(
        {
          runId: runContext.runId,
          workflowPath: runContext.workflowPath,
          startedAt: runContext.startedAt,
          finishedAt,
          ...(Number.isFinite(startedMs)
            ? { durationMs: Date.parse(finishedAt) - startedMs }
            : {}),
          status,
          ...(runError !== undefined
            ? { error: errorMessage(runError) }
            : {}),
          trigger: runContext.trigger,
          ...(runContext.permissions !== undefined ? { permissions: runContext.permissions } : {}),
          cells,
        },
        null,
        2
      )
    );
  } catch {
    // Swallowed on purpose — see the doc comment.
  }
  return status;
}

async function hydrateOutputsFromStubs(
  parser: WorkflowParser,
  platform: PlatformAdapter,
  content: string,
  outputs: Map<string, CellOutput>
): Promise<void> {
  const stubs = parser.parseOutputStubs(content);
  for (const [cellId, stub] of stubs.entries()) {
    if (outputs.has(cellId)) continue;
    if (!stub.outputPath) continue;

    // The link in the note is text a cell can rewrite, and the path may lead
    // through a symbolic link a cell planted: the platform refuses those.
    let raw: string;
    try {
      if (!(await platform.exists(stub.outputPath))) continue;
      raw = await platform.readFile(stub.outputPath);
    } catch (err) {
      platform.log("warn", `Not reading the recorded output of ${cellId}: ${errorMessage(err)}`);
      continue;
    }

    try {
      const record = JSON.parse(raw) as {
        cellId?: string;
        value?: unknown;
        meta?: OutputMeta;
      };
      if (!record?.meta || !record.cellId) continue;

      // The callout says which record is this cell's, and the callout is text
      // a cell, an edit or sync can change. A record that names another cell
      // is that cell's output, whatever the note links it under.
      if (record.cellId !== cellId) {
        platform.log(
          "warn",
          `Not reading the recorded output of ${cellId}: ${stub.outputPath} is the record of cell ${record.cellId}`
        );
        continue;
      }

      outputs.set(cellId, {
        cellId,
        value: record.value,
        meta: record.meta,
      });
    } catch {
      // Ignore malformed output files
    }
  }
}

async function persistCellOutput(
  platform: PlatformAdapter,
  runContext: RunContext,
  workflowPath: string,
  output: CellOutput
): Promise<string> {
  // The id is the file name as written: the parser keeps ids to names that
  // are safe as one, apart from each other and from run.json (Ore §5.3, §9.2).
  const outputPath = `${runContext.runDir}/${output.cellId}.json`;
  const outputViewPath = outputPath.replace(/\.json$/i, ".md");
  const artifacts = extractArtifacts(output.value);
  output.meta.artifacts = artifacts;
  output.meta.outputViewPath = outputViewPath;
  if (artifacts?.artifactDir) {
    await ensureArtifactIndex(platform, runContext, output, artifacts);
  }
  const record = {
    runId: runContext.runId,
    workflowPath,
    cellId: output.cellId,
    value: output.value,
    meta: {
      ...output.meta,
      runId: runContext.runId,
      outputPath,
      outputViewPath,
    },
  };

  await platform.writeFile(outputPath, JSON.stringify(record, null, 2));
  await platform.writeFile(
    outputViewPath,
    renderOutputMarkdown(output.cellId, record.meta, output.value, outputPath)
  );
  await updateRunIndex(platform, runContext, outputPath, outputViewPath, output);

  return outputPath;
}

async function updateRunIndex(
  platform: PlatformAdapter,
  runContext: RunContext,
  outputPath: string,
  outputViewPath: string,
  output: CellOutput
): Promise<void> {
  const indexPath = `${runContext.runBaseDir}/index.json`;
  let index: {
    workflowPath?: string;
    runs: Array<{
      runId: string;
      startedAt: string;
      status: "running" | "success" | "error";
      outputs: Record<
        string,
        {
          outputPath: string;
          outputViewPath: string;
          status: OutputMeta["status"];
          timestamp: string;
          artifacts?: { artifactDir?: string; files?: string[] };
        }
      >;
    }>;
  } = { runs: [] };

  if (await platform.exists(indexPath)) {
    try {
      const raw = await platform.readFile(indexPath);
      const parsed = JSON.parse(raw) as typeof index;
      if (parsed?.runs) index = parsed;
    } catch {
      // Ignore corrupted index and rebuild
    }
  }

  index.workflowPath = index.workflowPath ?? runContext.workflowPath;

  let runEntry = index.runs.find((run) => run.runId === runContext.runId);
  if (!runEntry) {
    runEntry = {
      runId: runContext.runId,
      startedAt: runContext.startedAt,
      status: "running",
      outputs: {},
    };
    index.runs.unshift(runEntry);
  }

  runEntry.outputs[output.cellId] = {
    outputPath,
    outputViewPath,
    status: output.meta.status,
    timestamp: output.meta.timestamp,
    ...(output.meta.artifacts ? { artifacts: output.meta.artifacts } : {}),
  };

  // A timed-out cell fails its run like an erroring one.
  if (output.meta.status !== "success") {
    runEntry.status = "error";
  } else if (runEntry.status !== "error") {
    runEntry.status = "success";
  }

  await platform.writeFile(indexPath, JSON.stringify(index, null, 2));
}

function createRunId(): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const rand = Math.random().toString(36).slice(2, 8);
  return `${timestamp}-${rand}`;
}

function runBasePath(outputRoot: string, workflowPath: string): string {
  const normalized = workflowPath
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\.\./g, "")
    .replace(/\.md$/i, "");
  return `${outputRoot}/runs/${normalized || "workflow"}`;
}

function normalizeOutputRoot(value: string | undefined): string {
  const fallback = "_vaultore";
  if (!value) return fallback;
  // Anchored /+ quantifiers backtrack across every offset on a long run of
  // slashes (CodeQL js/polynomial-redos); the helpers are linear.
  const normalized = stripTrailing(
    stripLeading(value.replace(/\\/g, "/"), "/"),
    "/"
  ).trim();
  return normalized || fallback;
}

function extractArtifacts(
  value: unknown
):
  | { artifactDir?: string; files?: string[] }
  | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const artifactDir =
    typeof record.artifactDir === "string" ? record.artifactDir : undefined;
  const files = Array.isArray(record.files)
    ? record.files.filter((file) => typeof file === "string")
    : undefined;
  if (!artifactDir && !files?.length) return undefined;
  return { artifactDir, files };
}

async function ensureArtifactIndex(
  platform: PlatformAdapter,
  runContext: RunContext,
  output: CellOutput,
  artifacts: { artifactDir?: string; files?: string[] }
): Promise<void> {
  if (!artifacts.artifactDir) return;
  const dir = stripTrailing(artifacts.artifactDir, "/");
  const indexPath = `${dir}/_index.md`;
  await platform.mkdirp(dir);
  await platform.writeFile(
    indexPath,
    renderArtifactIndex({
      cellId: output.cellId,
      runId: runContext.runId,
      workflowPath: runContext.workflowPath,
      timestamp: output.meta.timestamp,
      artifactDir: dir,
      files: artifacts.files,
    })
  );
}

/**
 * What of the vault a container sees. The mount is the enforcement: the TS
 * runtime's `vault.read` check runs inside the cell, which can bypass it
 * (`readRaw`, `Bun.file`), and a read-only mount stops writes, not reads
 * (#68).
 *
 * Without vaultRead, a cell that may write gets only this run's directory, at
 * the same path it has under a full mount, so it can record output without
 * seeing the vault — or earlier runs, which hold other workflows' note text.
 */
function vaultMounts(
  vaultRoot: string,
  permissions: Pick<ResolvedPermissions, "vaultRead" | "vaultWrite">,
  runContext: Pick<RunContext, "runDir">
): ContainerMount[] {
  if (permissions.vaultRead) {
    return [
      { source: vaultRoot, target: "/workspace", readonly: !permissions.vaultWrite },
    ];
  }
  if (!permissions.vaultWrite) return [];

  const root = stripTrailing(vaultRoot, "/");
  return [
    {
      source: `${root}/${runContext.runDir}`,
      target: `/workspace/${runContext.runDir}`,
      readonly: false,
    },
  ];
}

/**
 * Vault directories no cell may see, even under a full vault mount.
 *
 * The vault's config folder holds this plugin's code and settings: a cell
 * granted vaultWrite could otherwise rewrite the plugin that runs it (#28).
 * That is the folder the platform reports (`Vault#configDir` in Obsidian), and
 * `.obsidian` as well: Obsidian's config folder override is per device, so a
 * vault can carry another device's config, and its plugins, in the default
 * folder. A config folder is masked only when it exists, since masking a
 * missing directory makes the engine create it, and an empty one turns any
 * folder into an Obsidian vault.
 *
 * `.vaultore` holds the CLI's settings and stored permission decisions: a cell
 * could otherwise forge a grant for another workflow (#94). VaultOre owns this
 * directory, so it is created before the run and always masked; otherwise a
 * cell could create the config itself in a vault that has none yet.
 */
export const DEFAULT_CONFIG_DIR = ".obsidian";
const VAULTORE_STATE_DIR = ".vaultore";

/**
 * The config folders to hide: the platform's and the default. Refuses a
 * `configDir` that is not one vault-relative folder, rather than masking
 * nothing.
 */
function configDirsOf(platform: PlatformAdapter): string[] {
  const configured = platform.configDir.replace(/^\.[\\/]/, "").replace(/[\\/]+$/, "");
  if (configured === "" || configured === "." || configured === ".." || /[\\/]/.test(configured)) {
    throw new Error(
      `The platform's config folder must be one vault-relative folder, got ${JSON.stringify(platform.configDir)}`
    );
  }
  return configured.toLowerCase() === DEFAULT_CONFIG_DIR ? [DEFAULT_CONFIG_DIR] : [configured, DEFAULT_CONFIG_DIR];
}

/**
 * The directory hidden from cells that a vault-relative path lies in, if any.
 * Case-insensitive: on a case-insensitive file system `.Obsidian` is
 * `.obsidian`.
 */
function hiddenDirOf(path: string, configDirs: readonly string[]): string | undefined {
  const top = (path.split(/[\\/]/).find((segment) => segment !== "" && segment !== ".") ?? "").toLowerCase();
  return [...configDirs, VAULTORE_STATE_DIR].find((dir) => dir.toLowerCase() === top);
}

/**
 * Container paths to cover with an empty read-only tmpfs. Only under the full
 * vault mount, the only one that reaches them.
 */
async function maskedVaultPaths(
  platform: PlatformAdapter,
  permissions: Pick<ResolvedPermissions, "vaultRead">
): Promise<string[]> {
  if (!permissions.vaultRead) return [];
  const masked: string[] = [];
  for (const dir of configDirsOf(platform)) {
    if (await platform.exists(dir)) masked.push(`/workspace/${dir}`);
  }
  await platform.mkdirp(VAULTORE_STATE_DIR);
  masked.push(`/workspace/${VAULTORE_STATE_DIR}`);
  return masked;
}

// =============================================================================
// VAULT WRITES, APPLIED BY THE HOST (#83)
// =============================================================================

/**
 * `vault.write` in a TS cell does not write through the mount. The cell
 * collects its writes and hands them over after its output (see
 * parseCellStdout); the host applies them once the container has exited
 * successfully.
 *
 * Why: a cell that reads a note and writes it back can persist a stale copy.
 * Colima's sshfs sharing can show a container a file the host just rewrote
 * cut off at its old length (#83), and on any engine the user may edit the
 * note while the cell runs. Each write carries the hash of what the cell read
 * from that path (`base`); the host compares it with the note as it is now
 * and refuses the cell's writes when they differ.
 */

/**
 * What the cell knew of a path when it wrote it: the SHA-256 of the text it
 * last read there, that it found nothing there, or nothing at all (`null`: a
 * blind write, which the host applies as given).
 */
type WriteBase = { sha256: string } | { absent: true } | null;

interface PendingVaultWrite {
  path: string;
  content: string;
  base: WriteBase;
}

function handOffError(detail: string): Error {
  return new Error(
    `The cell's vault.write hand-off is malformed (${detail}); none of its writes were applied.`
  );
}

/**
 * The lines that frame a TS cell's output and its writes on stdout. Each run
 * of a cell gets its own random nonce in them, so text the cell logs (a
 * fetched page, a note) cannot pass for a block: it would have to contain
 * this nonce, which only the cell's own code can know (#125).
 */
interface CellFrame {
  outputStart: string;
  outputEnd: string;
  writesStart: string;
  writesEnd: string;
}

function newCellFrame(): CellFrame {
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
  return {
    outputStart: `__VAULTORE_OUTPUT_START_${nonce}__`,
    outputEnd: `__VAULTORE_OUTPUT_END_${nonce}__`,
    writesStart: `__VAULTORE_WRITES_START_${nonce}__`,
    writesEnd: `__VAULTORE_WRITES_END_${nonce}__`,
  };
}

function frameError(detail: string): Error {
  return new Error(
    `The cell's output framing is broken (${detail}); none of its writes were applied.`
  );
}

/**
 * A TS cell's value and pending writes from its stdout. The runtime prints
 * the output block (start line, the value as one line of JSON, end line) and
 * then the writes block (the same shape, a list of writes); JSON.stringify
 * never emits a raw newline, so a marker can only match a whole line.
 *
 * Exactly one output block and at most one writes block, after it, are
 * accepted; anything else carrying this run's nonce fails the cell. Lines
 * without the nonce are the cell's own logging and are ignored. Stdout with
 * no framing at all, as from a cell that exited early, is taken whole as the
 * value and applies no writes.
 */
function parseCellStdout(
  stdout: string,
  frame: CellFrame
): { value: unknown; writes: PendingVaultWrite[] } {
  const lines = stdout.split("\n").map((line) => line.replace(/\r$/, ""));
  const at = (marker: string) =>
    lines.flatMap((line, index) => (line === marker ? [index] : []));
  const outputStart = at(frame.outputStart);
  const outputEnd = at(frame.outputEnd);
  const writesStart = at(frame.writesStart);
  const writesEnd = at(frame.writesEnd);

  if (outputStart.length + outputEnd.length + writesStart.length + writesEnd.length === 0) {
    const whole = stdout.trim();
    try {
      return { value: JSON.parse(whole), writes: [] };
    } catch {
      return { value: whole, writes: [] };
    }
  }

  const [start] = outputStart;
  if (outputStart.length !== 1 || outputEnd.length !== 1 || start === undefined || outputEnd[0] !== start + 2) {
    throw frameError("expected exactly one output block");
  }
  const payload = lines[start + 1] ?? "";
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    value = payload;
  }

  if (writesStart.length === 0 && writesEnd.length === 0) return { value, writes: [] };
  const [writes] = writesStart;
  if (
    writesStart.length !== 1 ||
    writesEnd.length !== 1 ||
    writes === undefined ||
    writes < start + 3 ||
    writesEnd[0] !== writes + 2
  ) {
    throw frameError("expected at most one writes block, after the output block");
  }
  return { value, writes: parsePendingWrites(lines[writes + 1] ?? "") };
}

function parsePendingWrites(line: string): PendingVaultWrite[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw handOffError("not JSON");
  }
  if (!Array.isArray(parsed)) throw handOffError("not a list");

  const seen = new Set<string>();
  return parsed.map((entry: unknown, i) => {
    const write = entry as Partial<PendingVaultWrite> | null;
    if (!write || typeof write.path !== "string" || typeof write.content !== "string") {
      throw handOffError(`entry ${i} needs a path and text content`);
    }
    if (!isWriteBase(write.base)) throw handOffError(`entry ${i} has an invalid base`);
    if (seen.has(write.path)) throw handOffError(`${write.path} appears twice`);
    seen.add(write.path);
    return { path: write.path, content: write.content, base: write.base };
  });
}

function isWriteBase(base: unknown): base is WriteBase {
  if (base === null) return true;
  if (!base || typeof base !== "object") return false;
  const record = base as Record<string, unknown>;
  if (record.absent === true) return Object.keys(record).length === 1;
  return (
    Object.keys(record).length === 1 &&
    typeof record.sha256 === "string" &&
    /^[0-9a-f]{64}$/.test(record.sha256)
  );
}

/**
 * SHA-256 of a note's text, hex. A leading byte-order mark is left out on both
 * sides: Bun's `text()` drops it, Node's `readFile` keeps it.
 */
async function textSha256(text: string): Promise<string> {
  const unmarked = text.startsWith("\uFEFF") ? text.slice(1) : text;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(unmarked));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The vault-relative path a write may go to, or an error saying why not. The
 * host is the enforcement point for `vault.write`: the runtime's own checks
 * run inside the cell, which can hand over anything.
 */
function writablePath(
  path: string,
  permissions: Pick<ResolvedPermissions, "vaultRead" | "vaultWrite">,
  runDir: string,
  configDirs: readonly string[]
): string {
  if (!permissions.vaultWrite) {
    throw new Error(`Vault write permission denied: ${path}`);
  }
  if (/^[\\/]/.test(path) || /^[A-Za-z]:/.test(path)) {
    throw new Error(`Vault write outside the vault refused: ${path}`);
  }
  const segments = path.split(/[\\/]/).filter((segment) => segment !== "" && segment !== ".");
  if (segments.length === 0 || segments.includes("..")) {
    throw new Error(`Vault write outside the vault refused: ${JSON.stringify(path)}`);
  }
  const hidden = hiddenDirOf(segments.join("/"), configDirs);
  if (hidden) {
    throw new Error(`Vault write into ${hidden}/ refused: ${path}`);
  }

  const rel = segments.join("/");
  if (!permissions.vaultRead && rel !== runDir && !rel.startsWith(`${runDir}/`)) {
    throw new Error(
      `Vault write outside this run's directory (${runDir}) needs vaultRead: ${path}`
    );
  }
  return rel;
}

/**
 * Apply a cell's writes, all or none. Every path and every base is checked
 * before the first write, so a refusal leaves the vault as the cell found it.
 * A write without a base is applied as given.
 *
 * The check and the write are separate calls, so an edit landing in between
 * (milliseconds, against the seconds a container runs) is not caught.
 */
async function applyVaultWrites(
  platform: PlatformAdapter,
  permissions: Pick<ResolvedPermissions, "vaultRead" | "vaultWrite">,
  runContext: Pick<RunContext, "runDir">,
  writes: readonly PendingVaultWrite[]
): Promise<void> {
  if (writes.length === 0) return;

  const configDirs = configDirsOf(platform);
  const checked = writes.map((write) => ({
    ...write,
    path: writablePath(write.path, permissions, runContext.runDir, configDirs),
  }));

  // Where each path really leads, before anything is read or written: a cell
  // can plant a symbolic link through the mount. The rules above apply again
  // to the real path, so an in-vault link cannot reach a config folder either.
  const resolved: PendingVaultWrite[] = [];
  for (const write of checked) {
    let real: string;
    try {
      real = await platform.resolveInVault(write.path);
    } catch (err) {
      throw new Error(
        `Vault write refused: ${errorMessage(err)}. None of this cell's writes were applied.`
      );
    }
    const path = writablePath(real, permissions, runContext.runDir, configDirs);
    if (resolved.some((other) => other.path === path)) {
      throw new Error(
        `Vault write refused: ${write.path} is ${path}, which this cell also writes under another path. ` +
          "None of this cell's writes were applied."
      );
    }
    resolved.push({ ...write, path });
  }

  const conflicts: string[] = [];
  for (const write of resolved) {
    if (write.base === null) continue;
    const present = await platform.exists(write.path);
    if ("absent" in write.base) {
      if (present) conflicts.push(`${write.path} exists now; the cell found it missing`);
      continue;
    }
    if (!present) {
      conflicts.push(`${write.path} no longer exists`);
      continue;
    }
    const current = await platform.readFile(write.path);
    if ((await textSha256(current)) !== write.base.sha256) {
      conflicts.push(`${write.path} changed since this cell read it`);
    }
  }
  if (conflicts.length > 0) {
    throw new Error(
      `Vault write refused: ${conflicts.join("; ")}. ` +
        "Either the note was edited during the run, or the container saw a stale copy of it (#83). " +
        "None of this cell's writes were applied; run it again."
    );
  }

  const applied: string[] = [];
  for (const write of resolved) {
    try {
      await platform.writeFile(write.path, write.content);
    } catch (err) {
      const done = applied.length > 0 ? `already written: ${applied.join(", ")}` : "nothing was written before it";
      throw new Error(`Vault write to ${write.path} failed: ${errorMessage(err)} (${done}).`);
    }
    applied.push(write.path);
  }
}

async function executeTypeScriptCell(
  cell: Cell,
  platform: PlatformAdapter,
  permissions: ResolvedPermissions,
  outputs: Map<string, CellOutput>,
  runtime: typeof DEFAULT_RUNTIME,
  runContext: RunContext
): Promise<unknown> {
  const vaultRoot = await platform.getVaultRoot();
  const frame = newCellFrame();
  const runtimeScript = buildTypeScriptRuntime(outputs, permissions, runContext, frame);
  const { body, lastExpression } = extractLastExpression(cell.content);

  const script = `${runtimeScript}\n\nconst __vaultore_value = await (async () => {\n${body}\nreturn ${lastExpression};\n})();\nconst __vaultore_payload = JSON.stringify(__vaultore_value);\nconsole.log(${JSON.stringify(frame.outputStart)});\nconsole.log(__vaultore_payload);\nconsole.log(${JSON.stringify(frame.outputEnd)});\n__vaultore_handOff();\n`;

  const containerOpts: ContainerExecOptions = {
    image: runtime.image,
    command: ["sh", "-lc", "cat > /tmp/vaultore.ts && bun /tmp/vaultore.ts"],
    workdir: "/workspace",
    env: {
      VAULTORE_RUN_ID: runContext.runId,
      VAULTORE_OUTPUT_ROOT: runContext.outputRoot,
      VAULTORE_RUN_DIR: runContext.runDir,
    },
    stdin: script,
    timeout: (cell.attributes.timeout ?? runtime.timeout) * 1000,
    memoryLimit: runtime.memoryLimit,
    cpuLimit: runtime.cpuLimit,
    networkEnabled: permissions.network,
    mounts: vaultMounts(vaultRoot, permissions, runContext),
    maskedPaths: await maskedVaultPaths(platform, permissions),
  };

  const result = await execContainer(platform.timers, runtime.engine, containerOpts);
  if (result.timedOut) {
    throw new CellTimeoutError("ts", containerOpts.timeout);
  }
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || `ts cell failed: exit ${result.exitCode}`);
  }

  // Only a cell that succeeded gets its writes applied: one that failed part
  // way leaves the vault as it was.
  const { value, writes } = parseCellStdout(result.stdout, frame);
  await applyVaultWrites(platform, permissions, runContext, writes);
  return value;
}

async function executeShellCell(
  cell: Cell,
  platform: PlatformAdapter,
  permissions: ResolvedPermissions,
  runtime: typeof DEFAULT_RUNTIME,
  runContext: RunContext
): Promise<string> {
  const vaultRoot = await platform.getVaultRoot();
  const command = ["sh", "-lc", cell.content];

  // The same image as `ore:ts`: a note that sets `runtime.image` gets it for
  // every cell. The default, oven/bun:1-alpine, ships busybox `sh`.
  const containerOpts: ContainerExecOptions = {
    image: runtime.image,
    command,
    workdir: "/workspace",
    env: {
      VAULTORE_RUN_ID: runContext.runId,
      VAULTORE_OUTPUT_ROOT: runContext.outputRoot,
      VAULTORE_RUN_DIR: runContext.runDir,
    },
    timeout: (cell.attributes.timeout ?? runtime.timeout) * 1000,
    memoryLimit: runtime.memoryLimit,
    cpuLimit: runtime.cpuLimit,
    networkEnabled: permissions.network,
    mounts: vaultMounts(vaultRoot, permissions, runContext),
    maskedPaths: await maskedVaultPaths(platform, permissions),
  };

  const result = await execContainer(platform.timers, runtime.engine, containerOpts);
  if (result.timedOut) {
    throw new CellTimeoutError("shell", containerOpts.timeout);
  }
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || `shell cell failed: exit ${result.exitCode}`);
  }

  return result.stdout;
}

async function executeAICell(
  cell: Cell,
  platform: PlatformAdapter,
  permissions: ResolvedPermissions,
  outputs: Map<string, CellOutput>,
  interpolator: TemplateInterpolator
): Promise<string> {
  if (!permissions.network) {
    throw new Error("AI cells require network permission");
  }

  const providerName = resolveProviderName(
    platform.getSetting<string>("vaultore.defaultProvider")
  );
  const model =
    cell.attributes.model ??
    platform.getSetting<string>("vaultore.defaultModel") ??
    DEFAULT_MODELS[providerName];
  // Before anything is read or sent: a model the provider cannot serve fails
  // here with the fix, not as a provider 4xx after the prompt went out.
  assertModelMatchesProvider(providerName, model);

  const provider = await createProviderFromSettings(platform, providerName);
  const temperature =
    cell.attributes.temperature ??
    platform.getSetting<number>("vaultore.aiTemperature");
  const maxTokens =
    cell.attributes.maxTokens ??
    platform.getSetting<number>("vaultore.aiMaxTokens");
  // `{{note:}}` is a vault read: gate it here, where the path is known, so a
  // denial fails the cell before anything is sent (permissions-spec §3.3).
  const prompt = await interpolator.interpolateAsync(
    cell.content,
    outputs,
    async (path) => {
      if (!permissions.vaultRead) {
        throw new Error(`Vault read permission denied: {{note:${path}}}`);
      }
      try {
        // The config folders and .vaultore/ are hidden from cells (#28, #94):
        // the plugin's settings and the CLI's stored decisions must not reach
        // a provider either. Checked on the real path, after any link.
        const real = await platform.resolveInVault(path);
        const hidden = hiddenDirOf(real, configDirsOf(platform));
        if (hidden) {
          throw new Error(`${hidden}/ is hidden from cells`);
        }
        return await platform.readFile(real);
      } catch (err) {
        throw new Error(`Cannot read {{note:${path}}}: ${errorMessage(err)}`);
      }
    }
  );

  const response = await provider.complete({
    model,
    prompt,
    temperature,
    maxTokens,
  });

  return response.content;
}

function buildTypeScriptRuntime(
  outputs: Map<string, CellOutput>,
  permissions: ResolvedPermissions,
  runContext: RunContext,
  frame: Pick<CellFrame, "writesStart" | "writesEnd">
): string {
  const outputsSource = cellOutputsSource(outputs);

  const vaultRead = permissions.vaultRead ? "true" : "false";
  const vaultWrite = permissions.vaultWrite ? "true" : "false";
  const runId = JSON.stringify(runContext.runId);
  const outputRoot = JSON.stringify(runContext.outputRoot);
  const runDir = JSON.stringify(runContext.runDir);
  const workflowPath = JSON.stringify(runContext.workflowPath);

  return `
const __vaultore_outputs = ${outputsSource};
const vaultore = {
  runId: ${runId},
  outputRoot: ${outputRoot},
  runDir: ${runDir},
  workflowPath: ${workflowPath},
};
function cell(id) {
  const key = String(id);
  if (!__vaultore_outputs.has(key)) {
    throw new Error(\`Cell output not found: \${key}\`);
  }
  return __vaultore_outputs.get(key);
}

// Advisory: these checks turn a doomed access into a clear error where the
// cell made it. The mounts enforce reads (see vaultMounts); the host enforces
// vault.write, which it applies itself (applyVaultWrites).
const __vaultore_permissions = { vaultRead: ${vaultRead}, vaultWrite: ${vaultWrite} };
function __vaultore_rel(path) {
  return String(path).replace(/^\\//, "");
}
function __vaultore_writable(path) {
  if (!__vaultore_permissions.vaultWrite) {
    throw new Error("Vault write permission denied");
  }
  const rel = __vaultore_rel(path);
  if (__vaultore_permissions.vaultRead) return "/workspace/" + rel;
  const inRun = rel === vaultore.runDir || rel.startsWith(vaultore.runDir + "/");
  if (!inRun || rel.split("/").includes("..")) {
    throw new Error(
      "Vault write outside this run's directory (" + vaultore.runDir + ") needs vaultRead: " + path
    );
  }
  return "/workspace/" + rel;
}

// vault.write does not write through the mount: it records the write, and the
// host applies it after the cell succeeded, provided the note still holds what
// this cell read from it (#83). __vaultore_bases holds what the cell last saw
// on disk per path: the SHA-256 of the text it read, or that nothing was there.
const __vaultore_pending = new Map();
const __vaultore_bases = new Map();
let __vaultore_handedOff = false;
function __vaultore_sha256(text) {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(text.startsWith("\\uFEFF") ? text.slice(1) : text);
  return hasher.digest("hex");
}
function __vaultore_handOff() {
  console.log(${JSON.stringify(frame.writesStart)});
  console.log(JSON.stringify(Array.from(__vaultore_pending.values())));
  console.log(${JSON.stringify(frame.writesEnd)});
  __vaultore_handedOff = true;
}
// A cell that ends with process.exit() never reaches the hand-off; fail it
// rather than drop its writes without a word.
process.on("exit", () => {
  if (__vaultore_handedOff || __vaultore_pending.size === 0) return;
  require("node:fs").writeSync(
    2,
    "The cell exited before VaultOre could apply its " + __vaultore_pending.size +
      " vault.write call(s); nothing was written. Do not call process.exit() in a TS cell.\\n"
  );
  process.exitCode = 1;
});
const vault = {
  async read(path) {
    if (!__vaultore_permissions.vaultRead) {
      throw new Error("Vault read permission denied");
    }
    const rel = __vaultore_rel(path);
    const pending = __vaultore_pending.get(rel);
    if (pending) return pending.content;
    let text;
    try {
      text = await Bun.file("/workspace/" + rel).text();
    } catch (err) {
      if (err && err.code === "ENOENT") __vaultore_bases.set(rel, { absent: true });
      throw err;
    }
    __vaultore_bases.set(rel, { sha256: __vaultore_sha256(text) });
    return text;
  },
  async write(path, content) {
    __vaultore_writable(path);
    if (typeof content !== "string") {
      throw new TypeError(
        "vault.write takes text; got " + (content === null ? "null" : typeof content) + ": " + path
      );
    }
    const rel = __vaultore_rel(path);
    // A second write to the same path keeps the base of the first: the cell
    // has not seen the note on disk since.
    const base = __vaultore_pending.get(rel)?.base ?? __vaultore_bases.get(rel) ?? null;
    __vaultore_pending.set(rel, { path: rel, content, base });
  },
  async exists(path) {
    if (!__vaultore_permissions.vaultRead) {
      throw new Error("Vault read permission denied");
    }
    const rel = __vaultore_rel(path);
    if (__vaultore_pending.has(rel)) return true;
    const found = await Bun.file("/workspace/" + rel).exists();
    if (!found) __vaultore_bases.set(rel, { absent: true });
    return found;
  },
  async mkdirp(path) {
    const proc = Bun.spawn(["mkdir", "-p", __vaultore_writable(path)]);
    await proc.exited;
  },
  async readRaw(path) {
    return await Bun.file(path).text();
  },
};
`;
}

export function extractLastExpression(code: string): { body: string; lastExpression: string } {
  try {
    const ast = parse(code, {
      sourceType: "module",
      plugins: ["typescript", "topLevelAwait"],
      ranges: true,
    });

    const bodyNodes = ast.program.body;
    let idx = bodyNodes.length - 1;

    while (idx >= 0) {
      const node = bodyNodes[idx];
      if (!node || node.type === "EmptyStatement") {
        idx -= 1;
        continue;
      }
      break;
    }

    if (idx < 0) {
      // Babel files string literals that precede every other statement under
      // program.directives, not body. They are still expression statements
      // with a value, so a cell that is only `"text";` outputs the string.
      const directives = ast.program.directives;
      const lastDirective = directives[directives.length - 1];
      if (lastDirective) {
        return splitOffStatement(code, lastDirective, lastDirective.value);
      }
      return { body: code, lastExpression: "undefined" };
    }

    const lastNode = bodyNodes[idx];
    if (lastNode?.type === "ExpressionStatement") {
      return splitOffStatement(code, lastNode, lastNode.expression);
    }

    return { body: code, lastExpression: "undefined" };
  } catch {
    return { body: code, lastExpression: "undefined" };
  }
}

interface SourceRange {
  start?: number | null;
  end?: number | null;
}

// Removes `statement` from `code` and returns the source of `value` as the
// expression whose result the cell outputs.
function splitOffStatement(
  code: string,
  statement: SourceRange,
  value: SourceRange
): { body: string; lastExpression: string } {
  const statementStart = statement.start ?? 0;
  const statementEnd = statement.end ?? code.length;
  const exprStart = value.start ?? statementStart;
  const exprEnd = value.end ?? statementEnd;

  const body = `${code.slice(0, statementStart)}${code.slice(statementEnd)}`.trimEnd();
  const lastExpression = code.slice(exprStart, exprEnd).trim();
  return { body, lastExpression: lastExpression || "undefined" };
}

// No temp file helpers needed with stdin execution.
