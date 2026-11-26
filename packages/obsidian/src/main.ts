import {
  App,
  FileSystemAdapter,
  Modal,
  Plugin,
  PluginSettingTab,
  Setting,
  Notice,
  TFile,
  SecretComponent,
  requestUrl,
} from "obsidian";
import type { SettingDefinition, SettingDefinitionItem, SettingGroupItem } from "obsidian";
import {
  DEFAULT_MODELS,
  DEFAULT_PROVIDER,
  RunLockHeldError,
  MissedSlotError,
  SlotTakenError,
  WorkflowExecutor,
  WorkflowParser,
  WorkflowScheduler,
  MAX_KEEP_DAYS,
  acquireRunLock,
  catchUpMissedSlot,
  claimSlot,
  dismissMissedSlots,
  isLateSlot,
  lateAfterMs,
  answersStore,
  readMachineSettings,
  writeMachineSettings,
  openSchedules,
  legacyApprovalsPath,
  noteScheduleState,
  approveNote,
  approvalOf,
  catchUpRefusal,
  scheduledSince,
  setObsidianScheduling,
  approvalCovers,
  approvedPermissions,
  bindingOf,
  reviewApproval,
  scheduledNoteOf,
  revokeNote,
  agentStatus,
  ownerName,
  SHORT_LOCK_WAIT_MS,
  own,
  vaultKeyFor,
  readSlotRecord,
  recordMissedSlots,
  computeNextRun,
  describeHolder,
  describeRun,
  summarizeRun,
  errorMessage,
  isWorkflowFrontmatter,
  resolveInVaultRoot,
} from "@vaultore/core";
import { homedir } from "node:os";
import type {
  PlatformAdapter,
  PlatformRequest,
  PlatformResponse,
  AgentStatus,
  ApprovalPermissionKey,
  ApprovalReview,
  LockWait,
  NoteApproval,
  NoteScheduleState,
  ScheduledNoteNow,
  UnattendedApproval,
  ScheduleOwner,
  VaultSchedules,
  VaultStateStore,
  RunLock,
  ScheduledSlot,
  SlotClaim,
  SlotEntry,
  Timers,
} from "@vaultore/core";

interface VaultOreSettings {
  defaultProvider: "openai" | "anthropic";
  defaultModel: string;
  aiTemperature?: number;
  aiMaxTokens?: number;
  aiTimeoutSeconds?: number;
  runtimeEngine: "docker" | "podman" | "colima" | "apple";
  // Answers kept by earlier versions, which sync carried: never read (#299),
  // kept as found so an older plugin on another computer keeps its own.
  permissionDecisions?: Record<string, unknown>;
  outputRoot: string;
  // Names of entries in Obsidian's secret storage, picked with a
  // SecretComponent. The keys themselves never enter data.json.
  openaiSecretName: string;
  anthropicSecretName: string;
  // Days of scheduled-run history kept outside the vault, 0 to 30; blank is
  // 30. 0 keeps each run for a day only, which stops a second runner (#255).
  scheduleHistoryDays?: number;
}

// A workflow note with a schedule, as the settings tab lists it.
export interface ScheduledNote {
  path: string;
  schedule: string;
  // The note's approval on this computer, whichever runner owns it (#301).
  approval?: NoteApproval;
  // Whether its owner runs it as it is now (#299); undefined until the note was read.
  state?: NoteScheduleState;
  // Why the schedule cannot run, when it is not a valid cron expression.
  error?: string;
  // Set while the note is armed.
  nextRun?: Date;
}

const DEFAULT_SETTINGS: VaultOreSettings = {
  defaultProvider: DEFAULT_PROVIDER,
  defaultModel: DEFAULT_MODELS[DEFAULT_PROVIDER],
  aiMaxTokens: 800,
  aiTimeoutSeconds: 120,
  runtimeEngine: "docker",
  outputRoot: "_vaultore",
  openaiSecretName: "",
  anthropicSecretName: "",
};

type SecretNameSetting = "openaiSecretName" | "anthropicSecretName";

// The secret keys core asks for, mapped to the setting that names the secret
// and the label the user sees on that setting.
const SECRET_SETTINGS: Record<string, { setting: SecretNameSetting; label: string }> = {
  "openai.apiKey": { setting: "openaiSecretName", label: "OpenAI API key" },
  "anthropic.apiKey": { setting: "anthropicSecretName", label: "Anthropic API key" },
};

// Settings that no longer exist, dropped from data.json on load.
// enableWarmPool: a "future feature" toggle that never did anything.
const REMOVED_SETTINGS = ["enableWarmPool"];

// The scheduling switch and approvals moved to this machine's user tree
// (#276): consent a synced data.json must not grant, so they are read for
// nothing but the upgrade notice. They stay in data.json, written back as
// found: an older plugin on another computer that sync reaches keeps
// scheduling until it is upgraded, and each upgraded computer sees that
// scheduling was on. A later release drops them (#286).
const LEGACY_SCHEDULE_SETTINGS = ["runScheduledWorkflows", "scheduleApprovals"];

// Obsidian's per-device storage for this vault, which sync does not carry:
// set once the upgrade notice was shown on this computer.
const SCHEDULING_MOVED_NOTICE_KEY = "vaultore-scheduling-moved-notice-shown";

const SCHEDULER_DEBOUNCE_MS = 2000;

class ObsidianAdapter implements PlatformAdapter {
  readonly platform = "obsidian" as const;
  private plugin: VaultOrePlugin;

  constructor(plugin: VaultOrePlugin) {
    this.plugin = plugin;
  }

  get configDir(): string {
    return this.plugin.app.vault.configDir;
  }

  get timers(): Timers {
    return this.plugin.timers;
  }

  async readFile(path: string): Promise<string> {
    if (this.isInternalPath(path)) {
      const normalized = this.normalizePath(path);
      return this.plugin.app.vault.adapter.read(normalized);
    }
    const file = this.plugin.app.vault.getAbstractFileByPath(path);
    if (!file || !(file instanceof TFile)) {
      throw new Error(`File not found: ${path}`);
    }
    return this.plugin.app.vault.read(file);
  }

  async writeFile(path: string, content: string): Promise<void> {
    if (this.isInternalPath(path)) {
      const normalized = this.normalizePath(path);
      const parent = normalized.split("/").slice(0, -1).join("/");
      if (parent) {
        await this.mkdirpInternal(parent);
      }
      await this.plugin.app.vault.adapter.write(normalized, content);
      return;
    }
    const existing = this.plugin.app.vault.getAbstractFileByPath(path);
    if (existing && existing instanceof TFile) {
      await this.plugin.app.vault.modify(existing, content);
      return;
    }

    const parts = path.split("/").filter(Boolean);
    if (parts.length > 1) {
      await this.mkdirp(parts.slice(0, -1).join("/"));
    }
    await this.plugin.app.vault.create(path, content);
  }

  async exists(path: string): Promise<boolean> {
    if (this.isInternalPath(path)) {
      const normalized = this.normalizePath(path);
      return this.plugin.app.vault.adapter.exists(normalized);
    }
    return Boolean(this.plugin.app.vault.getAbstractFileByPath(path));
  }

  async mkdirp(path: string): Promise<void> {
    if (this.isInternalPath(path)) {
      const normalized = this.normalizePath(path);
      await this.mkdirpInternal(normalized);
      return;
    }
    const parts = path.split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const existing = this.plugin.app.vault.getAbstractFileByPath(current);
      if (existing) {
        if (existing instanceof TFile) {
          throw new Error(`Path exists and is a file: ${current}`);
        }
        continue;
      }
      try {
        await this.plugin.app.vault.createFolder(current);
      } catch (err) {
        const message = errorMessage(err);
        if (!message.toLowerCase().includes("already exists")) {
          throw err;
        }
      }
    }
  }

  async listFiles(directory: string, pattern?: string): Promise<string[]> {
    if (this.isInternalPath(directory)) {
      const normalized = this.normalizePath(directory);
      const listing = await this.plugin.app.vault.adapter.list(normalized);
      return listing.files
        .map((file) => file.replace(/\\/g, "/"))
        .filter((path) => (pattern ? path.includes(pattern) : true));
    }
    const files = this.plugin.app.vault.getFiles();
    const prefix = directory.endsWith("/") ? directory : `${directory}/`;
    return files
      .map((file) => file.path)
      .filter((path) => path.startsWith(prefix))
      .filter((path) => (pattern ? path.includes(pattern) : true));
  }

  async readRaw(path: string): Promise<string> {
    return this.plugin.app.vault.adapter.read(path);
  }

  async getVaultRoot(): Promise<string> {
    const adapter = this.plugin.app.vault.adapter;
    if (adapter instanceof FileSystemAdapter) {
      return adapter.getBasePath();
    }
    throw new Error("VaultOre requires a vault with file system access (desktop only)");
  }

  // On the file system, not through Obsidian's index: what matters is where
  // the host's write would land, and a cell can plant a link Obsidian has not
  // indexed yet. Without file system access there is nothing to check
  // against, so getVaultRoot throws and nothing is read or written.
  async resolveInVault(path: string): Promise<string> {
    return resolveInVaultRoot(await this.getVaultRoot(), this.normalizePath(path));
  }

  // The note's run lock, outside the vault and shared with the CLI, so a note
  // runs once at a time whether Obsidian or `vaultore agent` starts it (#215).
  async acquireRunLock(notePath: string): Promise<RunLock> {
    return acquireRunLock({
      vaultRoot: await this.getVaultRoot(),
      notePath,
      by: "Obsidian",
      onStale: (holder, why) => {
        this.log(
          "warn",
          `Removed the run lock of ${notePath}: ${describeHolder(holder)}, which took it at ${holder.since}, ${why}`
        );
      },
    });
  }

  // The schedule record, outside the vault and shared with the CLI, so a
  // scheduled occurrence runs once whether Obsidian or `vaultore agent` fires
  // it (#255). Claiming prunes the record by this plugin's history setting.
  async claimSlot(notePath: string, scheduled: ScheduledSlot): Promise<SlotClaim> {
    return claimSlot({
      vaultRoot: await this.getVaultRoot(),
      notePath,
      schedule: scheduled.schedule,
      slot: scheduled.slot,
      by: "Obsidian",
      keepDays: this.plugin.settings.scheduleHistoryDays,
      onPruneError: (path, err) => {
        this.log("warn", `Could not prune ${path} from the schedule record: ${errorMessage(err)}`);
      },
    });
  }

  /**
   * The answers this account gave on this computer, outside the vault and
   * shared with vaultore (#299). A change waits a moment for vaultore's.
   */
  permissionAnswers() {
    return answersStore({ wait: { timers: this.plugin.timers, ms: SHORT_LOCK_WAIT_MS } });
  }

  getSetting<T>(key: string): T | undefined {
    switch (key) {
      case "vaultore.defaultProvider":
        return this.plugin.settings.defaultProvider as T;
      case "vaultore.defaultModel":
        return this.plugin.settings.defaultModel as T;
      case "vaultore.aiTemperature":
        return this.plugin.settings.aiTemperature as T;
      case "vaultore.aiMaxTokens":
        return this.plugin.settings.aiMaxTokens as T;
      case "vaultore.aiTimeoutSeconds":
        return this.plugin.settings.aiTimeoutSeconds as T;
      case "vaultore.runtimeEngine":
        return this.plugin.settings.runtimeEngine as T;
      case "vaultore.outputRoot":
        return this.plugin.settings.outputRoot as T;
      default:
        return (this.plugin.settings as unknown as Record<string, unknown>)[key] as
          | T
          | undefined;
    }
  }

  async setSetting<T>(key: string, value: T): Promise<void> {
    switch (key) {
      case "vaultore.defaultProvider":
        this.plugin.settings.defaultProvider = value as VaultOreSettings["defaultProvider"];
        break;
      case "vaultore.defaultModel":
        this.plugin.settings.defaultModel = value as string;
        break;
      case "vaultore.aiTemperature":
        this.plugin.settings.aiTemperature = value as number | undefined;
        break;
      case "vaultore.aiMaxTokens":
        this.plugin.settings.aiMaxTokens = value as number | undefined;
        break;
      case "vaultore.aiTimeoutSeconds":
        this.plugin.settings.aiTimeoutSeconds = value as number | undefined;
        break;
      case "vaultore.runtimeEngine":
        this.plugin.settings.runtimeEngine = value as VaultOreSettings["runtimeEngine"];
        break;
      case "vaultore.outputRoot":
        this.plugin.settings.outputRoot = value as string;
        break;
      default:
        (this.plugin.settings as unknown as Record<string, unknown>)[key] = value;
    }
    await this.plugin.saveSettings();
  }

  async getSecret(key: string): Promise<string | undefined> {
    const spec = SECRET_SETTINGS[key];
    if (!spec) {
      throw new Error(`VaultOre has no setting for the secret "${key}"`);
    }
    const name = this.plugin.settings[spec.setting];
    if (!name) {
      throw new Error(
        `No secret selected for "${spec.label}". Select one under Settings → VaultOre → API keys.`
      );
    }
    const value = this.plugin.app.secretStorage.getSecret(name)?.trim();
    if (!value) {
      throw new Error(
        `The secret "${name}" selected for "${spec.label}" is missing or empty. ` +
          "Set its value in Obsidian's secret storage, or select another under Settings → VaultOre → API keys."
      );
    }
    return value;
  }

  // Secrets live in Obsidian's shared secret storage, which the user manages.
  // The plugin only reads the secret the user selected; it never writes one.
  async setSecret(key: string): Promise<void> {
    throw new Error(
      `VaultOre does not write secrets. Create or select one for "${key}" under Settings → VaultOre → API keys.`
    );
  }

  async deleteSecret(key: string): Promise<void> {
    throw new Error(
      `VaultOre does not delete secrets. Clear the selection for "${key}" under Settings → VaultOre → API keys.`
    );
  }

  /**
   * Provider calls go through requestUrl, which runs outside the renderer's
   * CORS: `fetch` from here carries a browser Origin that Anthropic rejects.
   * `throw: false` keeps the status and body of a 4xx/5xx for the error
   * message. requestUrl takes no abort signal; core bounds the call by
   * `timeoutMs`.
   */
  async request(req: PlatformRequest): Promise<PlatformResponse> {
    const response = await requestUrl({
      url: req.url,
      method: req.method,
      headers: req.headers,
      body: req.body,
      throw: false,
    });
    return { status: response.status, text: response.text };
  }

  showNotification(message: string, type: "info" | "warning" | "error"): void {
    new Notice(message);
  }

  async confirm(message: string): Promise<boolean> {
    return new Promise((resolve) => {
      const modal = new ConfirmModal(this.plugin.app, message, resolve);
      modal.open();
    });
  }

  log(level: "debug" | "info" | "warn" | "error", message: string, data?: unknown): void {
    const payload = data ? { message, data } : message;
    switch (level) {
      case "debug":
      case "info":
        // Keep routine logging at debug level per plugin guidelines —
        // hidden unless the user enables verbose console output.
        console.debug("[VaultOre]", payload);
        break;
      case "warn":
        console.warn("[VaultOre]", payload);
        break;
      case "error":
        console.error("[VaultOre]", payload);
        break;
    }
  }

  private isInternalPath(path: string): boolean {
    const normalized = this.normalizePath(path);
    return normalized === ".vaultore" || normalized.startsWith(".vaultore/");
  }

  private normalizePath(path: string): string {
    return path.replace(/^[\\/]+/, "");
  }

  private async mkdirpInternal(path: string): Promise<void> {
    const parts = path.split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const stat = await this.plugin.app.vault.adapter.stat(current);
      if (stat) {
        if (stat.type === "file") {
          throw new Error(`Path exists and is a file: ${current}`);
        }
        continue;
      }
      try {
        await this.plugin.app.vault.adapter.mkdir(current);
      } catch (err) {
        const message = errorMessage(err);
        if (!message.toLowerCase().includes("already exists")) {
          throw err;
        }
      }
    }
  }
}

/**
 * Whether approving needs the person (#299): a permission changed, an answer
 * no longer applies, or an `ask` needs an answer. Otherwise one action
 * approves, and nothing is asked.
 */
export function needsReview(review: ApprovalReview): boolean {
  return review.needsAnswer.length > 0 || review.permissions.some((p) => p.status === "changed" || p.status === "answer-dropped");
}

const REVIEW_STATUS: Record<ApprovalReview["permissions"][number]["status"], string> = {
  kept: "as approved",
  new: "set by the frontmatter",
  changed: "changed in the frontmatter",
  "needs-answer": "asks: answer for scheduled runs",
  "answer-dropped": "now set by the frontmatter; the answer given before no longer applies",
};

/**
 * The permissions a note runs with on schedule, and what changed since it
 * was approved (#299). Each `ask` gets an answer for unattended runs; an
 * answer given before is preselected. Resolves with the answers, or null.
 */
class ReviewModal extends Modal {
  private answers: Partial<Record<ApprovalPermissionKey, "allow" | "deny">> = {};
  private resolved = false;

  constructor(
    app: App,
    private readonly path: string,
    private readonly owner: ScheduleOwner,
    private readonly review: ApprovalReview,
    private readonly resolve: (answers: Partial<Record<ApprovalPermissionKey, "allow" | "deny">> | null) => void
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    this.setTitle(`Approve ${this.path} to run on schedule`);
    contentEl.createEl("p", {
      text:
        `Scheduled runs and catch-ups ${this.owner === "agent" ? "in vaultore agent" : "in Obsidian"} run with these permissions, ` +
        "and ask nothing. Runs you start yourself keep asking as before.",
    });
    let approve: HTMLButtonElement | undefined;
    const ready = (): void => {
      if (approve) approve.disabled = this.review.permissions.some((p) => p.now === "ask" && this.answers[p.key] === undefined);
    };
    for (const p of this.review.permissions) {
      const setting = new Setting(contentEl).setName(p.key);
      const before = p.status === "changed" && p.before ? `${p.before.value} → ` : "";
      if (p.now !== "ask") {
        setting.setDesc(`${before}${p.result?.value ?? p.now}: ${REVIEW_STATUS[p.status]}`);
        continue;
      }
      if (p.result?.source === "answer") this.answers[p.key] = p.result.value;
      setting.setDesc(p.status === "kept" ? "asks: the answer given when it was approved" : REVIEW_STATUS[p.status]);
      setting.addDropdown((dropdown) => {
        dropdown.addOption("", "Choose…");
        dropdown.addOption("allow", "Allow");
        dropdown.addOption("deny", "Deny");
        dropdown.setValue(this.answers[p.key] ?? "");
        dropdown.onChange((value) => {
          if (value === "allow" || value === "deny") this.answers[p.key] = value;
          else delete this.answers[p.key];
          ready();
        });
      });
    }
    const buttonRow = contentEl.createDiv({ cls: "modal-button-container" });
    approve = buttonRow.createEl("button", { text: "Approve", cls: "mod-cta" });
    approve.addEventListener("click", () => {
      this.settled({ ...this.answers });
      this.close();
    });
    buttonRow.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
    ready();
  }

  onClose(): void {
    this.contentEl.empty();
    this.settled(null);
  }

  private settled(value: Partial<Record<ApprovalPermissionKey, "allow" | "deny">> | null): void {
    if (this.resolved) return;
    this.resolved = true;
    this.resolve(value);
  }
}

class ConfirmModal extends Modal {
  private message: string;
  private resolve: (value: boolean) => void;
  private resolved = false;

  constructor(app: App, message: string, resolve: (value: boolean) => void) {
    super(app);
    this.message = message;
    this.resolve = resolve;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("p", { text: this.message });
    const buttonRow = contentEl.createDiv({ cls: "modal-button-container" });

    buttonRow
      .createEl("button", { text: "Allow", cls: "mod-cta" })
      .addEventListener("click", () => {
        this.settled(true);
        this.close();
      });

    buttonRow
      .createEl("button", { text: "Deny" })
      .addEventListener("click", () => {
        this.settled(false);
        this.close();
      });
  }

  onClose(): void {
    this.contentEl.empty();
    // If modal is closed via Esc without clicking a button, deny by default
    this.settled(false);
  }

  private settled(value: boolean): void {
    if (this.resolved) return;
    this.resolved = true;
    this.resolve(value);
  }
}

export default class VaultOrePlugin extends Plugin {
  settings: VaultOreSettings = DEFAULT_SETTINGS;
  private adapter!: ObsidianAdapter;
  private executor = new WorkflowExecutor();
  private parser = new WorkflowParser();
  /**
   * Core's timers, from this window. An interval is registered with the
   * plugin, so unloading the plugin clears it even if nothing stops it.
   */
  readonly timers: Timers = {
    setTimeout: (callback, ms) => window.setTimeout(callback, ms),
    clearTimeout: (handle) => window.clearTimeout(handle as number),
    setInterval: (callback, ms) => this.registerInterval(window.setInterval(callback, ms)),
    clearInterval: (handle) => window.clearInterval(handle as number),
  };
  private scheduler = new WorkflowScheduler({
    timers: this.timers,
    tickIntervalMs: 60 * 1000,
    onTick: (workflows) => {
      for (const workflow of workflows) {
        // Re-checked at fire time: a schedule edit or a withdrawn approval
        // reaches the registrations only after the debounced refresh.
        if (!this.isApprovedSchedule(workflow.path, workflow.cronExpression)) {
          this.adapter.log(
            "info",
            `Skipped the scheduled run of ${workflow.path}: its schedule or approval changed`
          );
          continue;
        }
        // A tick that comes late (the machine slept) does not run the slot
        // it held: that slot, and any after it, are missed runs (#269).
        if (isLateSlot(workflow.slot, new Date(), this.scheduler.lateAfterMs)) {
          void this.lookForMissedRuns(workflow.path, workflow.cronExpression, workflow.armedAt);
          continue;
        }
        // A later occurrence came due in the same tick and runs instead.
        if (workflow.superseded) {
          void this.recordSkippedSlot(
            workflow.path,
            { schedule: workflow.cronExpression, slot: workflow.slot },
            "a later occurrence came due at the same time and ran instead"
          );
          continue;
        }
        void this.runWorkflowByPath(workflow.path, {
          schedule: workflow.cronExpression,
          slot: workflow.slot,
        });
      }
    },
  });
  private schedulerRefreshTimer: number | null = null;
  private runningWorkflows = new Set<string>();
  // The vault's open missed runs, as the settings list them (#269). Read from
  // the record outside the vault when gaps are found or resolved, and when
  // the schedules are refreshed.
  missedRuns: SlotEntry[] = [];
  // Obsidian keeps a settings tab as it last drew it, also across closing and
  // opening the settings, until the tab's update() (Obsidian 1.15.1); a list
  // that changes on its own (missed runs) redraws it.
  private settingsTab: VaultOreSettingsTab | undefined;
  // Invalid schedules already reported, as "path\nschedule", so a typo is
  // reported once rather than on every vault change.
  private reportedInvalidSchedules = new Set<string>();

  async onload(): Promise<void> {
    await this.loadSettings();
    this.adapter = new ObsidianAdapter(this);
    // After the adapter: a file that cannot be used is logged through it.
    await this.loadMachineSettings();
    await this.loadSchedules();
    this.noticeSchedulingMoved();

    // The run commands are offered only on workflow notes, so the palette
    // does not show them on every Markdown note in the vault.
    this.addCommand({
      id: "run-all",
      name: "Run all cells",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!this.isWorkflowNote(file)) return false;
        if (!checking) {
          void this.runWorkflow(file);
        }
        return true;
      },
    });

    this.addCommand({
      id: "run-cell",
      name: "Run cell",
      editorCheckCallback: (checking, editor, view) => {
        const file = view.file;
        if (!this.isWorkflowNote(file)) return false;
        if (!checking) {
          void this.runCellAtLine(file, editor.getCursor().line + 1);
        }
        return true;
      },
    });

    this.addCommand({
      id: "run-cell-only",
      name: "Run cell only (skip dependencies)",
      editorCheckCallback: (checking, editor, view) => {
        const file = view.file;
        if (!this.isWorkflowNote(file)) return false;
        if (!checking) {
          void this.runCellAtLine(file, editor.getCursor().line + 1, {
            skipDependencies: true,
          });
        }
        return true;
      },
    });

    this.settingsTab = new VaultOreSettingsTab(this.app, this);
    this.addSettingTab(this.settingsTab);

    this.scheduler.start();
    // Each minute: missed runs the agent resolved, a late threshold
    // `vaultore schedules late-after` changed, and whether vaultore agent
    // runs, for the notes handed to it: it may start or stop at any time (#301).
    this.timers.setInterval(() => {
      void this.recheckMissedRuns();
      void this.loadMachineSettings();
      void this.reloadSchedules().then(() => this.refreshAgentStatus());
    }, 60 * 1000);

    // Defer the initial vault scan until the workspace layout (and metadata
    // cache) is ready, so plugin load stays fast on large vaults.
    this.app.workspace.onLayoutReady(() => {
      void this.refreshScheduledNow();
      // Open missed runs found earlier, by this runner or the agent (#269).
      void this.refreshMissedRuns();
    });

    this.registerEvent(
      this.app.metadataCache.on("changed", () => {
        this.debouncedRefreshScheduledWorkflows();
      })
    );
    // An approval belongs to a path. When the note leaves that path, the
    // approval goes with it, so a different note arriving there later is not
    // armed by a decision made about another one.
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (file instanceof TFile && file.extension === "md") {
          void this.dropScheduleApproval(file.path);
          this.debouncedRefreshScheduledWorkflows();
        }
      })
    );
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (file instanceof TFile && file.extension === "md") {
          void this.dropScheduleApproval(oldPath);
          this.debouncedRefreshScheduledWorkflows();
        }
      })
    );
  }

  onunload(): void {
    this.scheduler.stop();
    if (this.schedulerRefreshTimer !== null) {
      window.clearTimeout(this.schedulerRefreshTimer);
      this.schedulerRefreshTimer = null;
    }
  }

  async loadSettings(): Promise<void> {
    const data = (await this.loadData()) as Partial<VaultOreSettings> | null;
    const settings = {
      ...DEFAULT_SETTINGS,
      ...(data ?? {}),
    };
    let dropped = false;
    for (const key of REMOVED_SETTINGS) {
      if (key in settings) dropped = true;
      delete (settings as Record<string, unknown>)[key];
    }
    const legacy: Record<string, unknown> = {};
    for (const key of LEGACY_SCHEDULE_SETTINGS) {
      if (Object.prototype.hasOwnProperty.call(settings, key)) {
        legacy[key] = (settings as Record<string, unknown>)[key];
        delete (settings as Record<string, unknown>)[key];
      }
    }
    this.legacyScheduleSettings = legacy;
    this.settings = settings;
    if (dropped) await this.saveSettings();
  }

  // The old scheduling keys as data.json holds them, written back unchanged
  // on every save and read for nothing else (LEGACY_SCHEDULE_SETTINGS).
  private legacyScheduleSettings: Record<string, unknown> = {};

  /** Whether data.json says scheduling was on before it moved to each computer (#276). */
  get scheduledBeforeUpgrade(): boolean {
    return this.legacyScheduleSettings["runScheduledWorkflows"] === true;
  }

  /**
   * Says once on this computer that scheduling is off here since it moved to
   * each computer, when data.json says it was on and it is not on here yet.
   * Stays until dismissed: a schedule that stopped is not seen otherwise.
   */
  private noticeSchedulingMoved(): void {
    if (!this.scheduledBeforeUpgrade || this.schedules.obsidianScheduling) return;
    if (this.app.loadLocalStorage(SCHEDULING_MOVED_NOTICE_KEY) !== null) return;
    new Notice(
      "VaultOre: scheduled workflows are now turned on separately for each account on each computer, and are off here. " +
        "To run them here, turn them on and approve your notes under Settings → VaultOre → Scheduled workflows.",
      0
    );
    this.app.saveLocalStorage(SCHEDULING_MOVED_NOTICE_KEY, true);
  }

  // This computer's schedules for the vault, shared with vaultore agent
  // (#276, #301): "Run scheduled workflows" and each approved note with the
  // runner that owns it, in the user tree. Off with nothing approved until
  // read, and when it cannot be read.
  schedules: VaultSchedules = { obsidianScheduling: false, obsidianBinding: "strict", notes: {} };
  // Why the schedules file could not be read when last read; while set, the
  // plugin holds no approvals, so nothing runs on schedule or catches up
  // (#307). Said once per reason.
  schedulesError: string | undefined;
  private schedulesStore: VaultStateStore<VaultSchedules> | undefined;
  // A change of a file vaultore changes too waits a moment for it, rather
  // than failing a click (#291).
  private get shortWait(): LockWait {
    return { timers: this.timers, ms: SHORT_LOCK_WAIT_MS };
  }

  private async openSchedulesStore(): Promise<VaultStateStore<VaultSchedules>> {
    this.schedulesStore ??= await openSchedules({
      wait: this.shortWait,
      legacyApprovals: legacyApprovalsPath({ env: process.env, platform: process.platform, homedir: homedir() }),
      onImported: (from, to) => {
        this.adapter.log("info", `Copied vaultore agent's approvals from ${from} to ${to}`);
        // Said once the notes are read, naming those that wait for an answer.
        this.approvalsImported = true;
      },
      onLegacyChanged: (from) => {
        this.adapter.log("warn", `${from} changed since its approvals were copied in; the change is not used`);
        new Notice(
          `VaultOre: ${from} changed since its approvals were copied in, so the change is not used. ` +
            "Approve those notes under Settings → VaultOre → Scheduled workflows, and remove the old file."
        );
      },
    });
    return this.schedulesStore;
  }

  /** Reads this computer's schedules for the vault. */
  async loadSchedules(): Promise<void> {
    try {
      const store = await this.openSchedulesStore();
      this.schedules = await store.forVault(await vaultKeyFor(await this.adapter.getVaultRoot()));
      this.schedulesError = undefined;
    } catch (err) {
      this.schedules = { obsidianScheduling: false, obsidianBinding: "strict", notes: {} };
      this.schedulesError = errorMessage(err);
      this.adapter.log("warn", this.schedulesError);
      new Notice(`VaultOre: scheduled workflows stay off. ${this.schedulesError}`);
    }
    await this.refreshAgentStatus();
    await this.refreshScheduledNow();
    if (this.approvalsImported) {
      this.approvalsImported = false;
      this.noticeImportedApprovals();
    }
  }

  // Approvals of 0.4.x were copied in at this start (#301).
  private approvalsImported = false;

  /**
   * Tells which of the agent's approvals of 0.4.x run as before, and which
   * wait for an answer: those held no answers, so a note with an `ask` does
   * not run until approved again with one (#310).
   */
  private noticeImportedApprovals(): void {
    const waiting = Object.entries(this.schedules.notes)
      .filter(([path, approval]) => {
        const state = this.noteState(path);
        return approval.permissions === undefined && state?.state === "changed" && state.review.needsAnswer.length > 0;
      })
      .map(([path]) => path);
    const where = "Settings → VaultOre → Scheduled workflows";
    new Notice(
      waiting.length === 0
        ? `VaultOre: the notes approved for vaultore agent are now listed under ${where}, and the agent runs them as before.`
        : `VaultOre: the notes approved for vaultore agent are now listed under ${where}. ` +
            `${waiting.join(", ")} ${waiting.length === 1 ? "asks" : "ask"} for a permission, which approvals of earlier versions held no answer for, ` +
            `so ${waiting.length === 1 ? "it does" : "they do"} not run until you answer: Review under ${where}, ` +
            "or vaultore schedules approve <note> --allow <permission>. The others run as before.",
      0
    );
  }

  // Each approved note as it is now, read from the note (#299): what its
  // approval is checked against. A string says why the note could not be read.
  private scheduledNow = new Map<string, ScheduledNoteNow | string>();
  // Notes said to have changed since their approval, with the state they were
  // in, so each change is told once, not on every refresh.
  private announcedChanges = new Map<string, string>();

  /** Reads a scheduled note as an approval sees it: its schedule, hash and permissions. */
  private async readNoteNow(path: string): Promise<ScheduledNoteNow> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new Error("it no longer exists");
    const content = await this.app.vault.read(file);
    if (!this.parser.isWorkflow(content)) throw new Error("it is not a workflow note");
    const note = await scheduledNoteOf(this.parser.parse(content, path), this.parser);
    if (note === undefined) throw new Error("it has no schedule");
    return note;
  }

  /** Whether the note's owner runs it as it is now; undefined while the note is not read yet. */
  noteState(path: string): NoteScheduleState | undefined {
    const now = this.scheduledNow.get(path);
    const approval = approvalOf(this.schedules, path);
    if (approval === undefined) return { state: "not-approved" };
    if (now === undefined || typeof now === "string") return undefined;
    return noteScheduleState(approval.owner, this.schedules, now);
  }

  /**
   * Reads every approved note again, then re-arms, and tells once of each
   * note of Obsidian's that changed since it was approved, so that it does
   * not run on schedule.
   */
  async refreshScheduledNow(): Promise<void> {
    const next = new Map<string, ScheduledNoteNow | string>();
    for (const path of Object.keys(this.schedules.notes)) {
      try {
        next.set(path, await this.readNoteNow(path));
      } catch (err) {
        next.set(path, errorMessage(err));
      }
    }
    this.scheduledNow = next;
    this.refreshScheduledWorkflows();

    const changed = new Map<string, string>();
    for (const path of Object.keys(this.schedules.notes)) {
      const state = this.noteState(path);
      if (state?.state !== "changed" || state.approval.owner !== "obsidian") continue;
      const signature = JSON.stringify([state.approval.approvedAt, this.scheduledNow.get(path)]);
      changed.set(path, signature);
      if (this.announcedChanges.get(path) === signature) continue;
      new Notice(
        `VaultOre: ${path} changed since you approved it, so it does not run on schedule. ` +
          "Review it under Settings → VaultOre → Scheduled workflows."
      );
    }
    this.announcedChanges = changed;
    this.settingsTab?.update();
  }

  // Whether vaultore agent runs this vault, for the notes handed to it
  // (#301); undefined until read.
  agentStatus: AgentStatus | undefined;
  private agentStoppedNoticeShown = false;

  /** Reads whether the agent runs this vault; says once when it does not run the notes handed to it. */
  async refreshAgentStatus(): Promise<void> {
    try {
      this.agentStatus = await agentStatus({ vaultKey: await vaultKeyFor(await this.adapter.getVaultRoot()) });
    } catch (err) {
      this.adapter.log("warn", `Could not tell whether vaultore agent runs: ${errorMessage(err)}`);
      this.agentStatus = undefined;
    }
    const handed = Object.entries(this.schedules.notes).filter(([, approval]) => approval.owner === "agent");
    if (handed.length > 0 && this.agentStatus?.state === "stopped" && !this.agentStoppedNoticeShown) {
      this.agentStoppedNoticeShown = true;
      new Notice(
        `VaultOre: ${handed.length} scheduled note(s) are handed to vaultore agent, which does not run this vault, so they do not run. ` +
          "Start it, or run them in Obsidian under Settings → VaultOre → Scheduled workflows."
      );
    }
  }

  // Changes run one after another: the store's file lock refuses a second
  // writer rather than waiting, and a delete and a rename, or two quick
  // clicks, would otherwise collide within this process.
  private schedulesQueue: Promise<void> = Promise.resolve();

  /** Changes this machine's scheduling consent, then re-arms. A change that cannot be saved is told and not applied. */
  private changeSchedules(change: (entry: VaultSchedules) => void): Promise<void> {
    const next = this.schedulesQueue.then(() => this.applyScheduleChange(change));
    this.schedulesQueue = next;
    return next;
  }

  private async applyScheduleChange(change: (entry: VaultSchedules) => void): Promise<void> {
    try {
      const key = await vaultKeyFor(await this.adapter.getVaultRoot());
      const store = await this.openSchedulesStore();
      await store.update(key, change);
      this.schedules = await store.forVault(key);
    } catch (err) {
      this.adapter.log("warn", errorMessage(err));
      new Notice(`VaultOre: could not save the scheduling setting. ${errorMessage(err)}`);
    }
    await this.refreshScheduledNow();
  }

  async saveSettings(): Promise<void> {
    await this.saveData({ ...this.settings, ...this.legacyScheduleSettings });
  }

  // How late a scheduled run may start, in minutes; undefined is the default.
  // This machine's, shared with vaultore agent: not in data.json (#269).
  lateAfterMinutes: number | undefined;
  private machineSettingsError = "";

  /**
   * Reads this machine's shared settings (the late threshold). A file that
   * cannot be used is told of once, and the last good value is kept.
   */
  async loadMachineSettings(): Promise<void> {
    try {
      const settings = await readMachineSettings();
      this.machineSettingsError = "";
      this.lateAfterMinutes = settings.lateAfterMinutes;
      this.scheduler.lateAfterMs = lateAfterMs(this.lateAfterMinutes);
    } catch (err) {
      const message = errorMessage(err);
      if (message !== this.machineSettingsError) {
        this.adapter.log("warn", message);
        new Notice(`VaultOre: ${message}. Scheduled runs keep a late threshold of ${this.scheduler.lateAfterMs / 60_000} minutes.`);
      }
      this.machineSettingsError = message;
    }
  }

  /** Sets the late threshold for this machine; undefined goes back to the default. */
  async setLateAfterMinutes(minutes: number | undefined): Promise<void> {
    const settings = await writeMachineSettings({ lateAfterMinutes: minutes }, { wait: this.shortWait });
    this.lateAfterMinutes = settings.lateAfterMinutes;
    this.scheduler.lateAfterMs = lateAfterMs(this.lateAfterMinutes);
  }

  // Command checks run synchronously on every palette open, so they read the
  // metadata cache's parsed frontmatter rather than the note's text.
  private isWorkflowNote(file: TFile | null): file is TFile {
    if (!file || file.extension !== "md") return false;
    return isWorkflowFrontmatter(this.app.metadataCache.getFileCache(file)?.frontmatter);
  }

  /**
   * A slot not run is still decided: claimed and recorded as skipped, so it is
   * neither run later nor lost between the record's slots (#269).
   */
  private async recordSkippedSlot(path: string, scheduled: ScheduledSlot, reason: string): Promise<void> {
    try {
      const claim = await this.adapter.claimSlot(path, scheduled);
      await claim.finish({ result: "skipped", reason });
      this.adapter.log("info", `Skipped the ${scheduled.slot.toISOString()} run of ${path}: ${reason}`);
    } catch (err) {
      if (!(err instanceof SlotTakenError)) this.adapter.log("warn", `Could not record the skipped run of ${path}: ${errorMessage(err)}`);
    }
  }

  private async runWorkflow(
    file: TFile,
    scheduled?: ScheduledSlot,
    slotClaim?: SlotClaim,
    unattended?: UnattendedApproval
  ): Promise<void> {
    if (this.runningWorkflows.has(file.path)) {
      // A held catch-up is finished as skipped too.
      const reason = "the note was still running";
      if (scheduled) {
        await this.recordSkippedSlot(file.path, scheduled, reason);
        return;
      }
      await slotClaim?.finish({ result: "skipped", reason }).catch(() => undefined);
      new Notice("VaultOre: Workflow is already running");
      return;
    }

    this.runningWorkflows.add(file.path);
    let startNotice: Notice | undefined;

    try {
      // Inside the try: a read that rejects (note deleted or renamed between
      // resolution and read) previously escaped before the finally, leaving the
      // path marked as running for the rest of the session — it could never be
      // run again without reloading the plugin.
      const content = await this.app.vault.read(file);
      // A scheduled run shows itself once a cell starts: before that its slot
      // may turn out to be the other runner's, which is no news (#255).
      if (!scheduled) {
        startNotice = new Notice(`VaultOre: Running ${file.basename}...`, 0);
      }

      // The cells this run started: the outputs it returns also hold results
      // of earlier runs, which must not count towards how this one went.
      const ran: string[] = [];
      const workflow = await this.executor.runWorkflow({
        platform: this.adapter,
        workflowPath: file.path,
        content,
        ...(scheduled ? { scheduled } : {}),
        ...(slotClaim ? { slotClaim } : {}),
        ...(unattended ? { unattended } : {}),
        runner: "Obsidian",
        emitEvent: (event, data) => {
          if (event === "cell:started") {
            const cellId = (data as { cellId?: string })?.cellId;
            if (cellId) {
              ran.push(cellId);
              startNotice ??= new Notice(`VaultOre: Running ${file.basename}...`, 0);
              startNotice.setMessage(`VaultOre: Running cell ${cellId}...`);
            }
          }
        },
      });
      new Notice(`VaultOre: ${describeRun(file.basename, summarizeRun(workflow.cells, workflow.outputs, ran))}`);
    } catch (err) {
      // The other runner has this occurrence: nothing to tell the user about
      // every minute; `vaultore schedules log` shows who ran it.
      if (err instanceof SlotTakenError) {
        this.adapter.log("info", err.message);
        return;
      }
      // A catch-up that failed before the run began (the note could not be
      // read): its gap is finished as failed, not left taken. Finishing again
      // after the executor did changes nothing.
      await slotClaim?.finish({ result: "failed", reason: errorMessage(err) }).catch(() => undefined);
      new Notice(runFailureNotice(err));
    } finally {
      // The notice is only created once the read succeeds, so it may not exist.
      startNotice?.hide();
      this.runningWorkflows.delete(file.path);
    }
  }

  private async runWorkflowByPath(path: string, scheduled: ScheduledSlot): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      // Moved or deleted since the schedule was armed; the vault event that
      // drops it may not have arrived yet.
      const message = `VaultOre: Scheduled workflow ${path} was not run: the note no longer exists`;
      this.adapter.log("warn", message);
      new Notice(message);
      return;
    }
    // The schedules file is shared with vaultore agent (#301): a note handed
    // to it, or revoked, since this note was armed does not run here.
    await this.reloadSchedules();
    // Read as it is now: it runs with the permissions it was approved with,
    // asks nothing and stores nothing (#299). The executor checks the
    // approval again against the content it runs.
    let state: NoteScheduleState;
    try {
      state = noteScheduleState("obsidian", this.schedules, await this.readNoteNow(path));
    } catch (err) {
      this.adapter.log("info", `Skipped the scheduled run of ${path}: ${errorMessage(err)}`);
      return;
    }
    if (state.state !== "approved" || state.approval.schedule !== scheduled.schedule) {
      this.adapter.log("info", `Skipped the scheduled run of ${path}: it is no longer Obsidian's to run as it is`);
      return;
    }
    await this.runWorkflow(file, scheduled, undefined, { approval: state.approval, binding: bindingOf(this.schedules, "obsidian") });
  }

  /**
   * Reads the schedules file again, as vaultore agent and `vaultore schedules`
   * change it too, and re-arms when it changed. A file that cannot be read
   * now holds no approvals: what was read last may have been revoked since,
   * so nothing runs on it until the file can be read again (#307).
   */
  async reloadSchedules(): Promise<void> {
    let next: VaultSchedules;
    try {
      const store = await this.openSchedulesStore();
      next = await store.forVault(await vaultKeyFor(await this.adapter.getVaultRoot()));
      if (this.schedulesError !== undefined) {
        this.schedulesError = undefined;
        this.settingsTab?.update();
      }
    } catch (err) {
      next = { obsidianScheduling: false, obsidianBinding: "strict", notes: {} };
      const message = errorMessage(err);
      if (message !== this.schedulesError) {
        this.schedulesError = message;
        this.adapter.log("warn", `Could not read the schedules again: ${message}`);
        new Notice(`VaultOre: scheduled workflows stopped until the schedules can be read again. ${message}`);
        this.settingsTab?.update();
      }
    }
    if (JSON.stringify(next) === JSON.stringify(this.schedules)) return;
    this.schedules = next;
    await this.refreshScheduledNow();
  }

  private debouncedRefreshScheduledWorkflows(): void {
    if (this.schedulerRefreshTimer !== null) {
      window.clearTimeout(this.schedulerRefreshTimer);
    }
    this.schedulerRefreshTimer = window.setTimeout(() => {
      this.schedulerRefreshTimer = null;
      void this.refreshScheduledNow();
    }, SCHEDULER_DEBOUNCE_MS);
  }

  /**
   * Every workflow note with a schedule, approved or not, sorted by path.
   * Reads the metadata cache, so it stays cheap on large vaults.
   */
  getScheduledNotes(): ScheduledNote[] {
    const registered = new Map(this.scheduler.list().map((entry) => [entry.path, entry]));
    const notes: ScheduledNote[] = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      const schedule = this.scheduleOf(file);
      if (schedule === undefined) continue;
      let error: string | undefined;
      try {
        computeNextRun(schedule);
      } catch (err) {
        error = errorMessage(err);
      }
      const entry = registered.get(file.path);
      notes.push({
        path: file.path,
        schedule,
        ...(own(this.schedules.notes, file.path) ? { approval: own(this.schedules.notes, file.path) } : {}),
        ...(this.noteState(file.path) ? { state: this.noteState(file.path) } : {}),
        error,
        nextRun: entry?.cronExpression === schedule ? entry.nextRun : undefined,
      });
    }
    return notes.sort((a, b) => a.path.localeCompare(b.path));
  }

  async setRunScheduledWorkflows(enabled: boolean): Promise<void> {
    await this.changeSchedules((entry) => {
      setObsidianScheduling(entry, enabled);
    });
  }

  /** What Obsidian's approvals bind (#299): the whole note, or its schedule and permissions. */
  async setObsidianBinding(binding: VaultSchedules["obsidianBinding"]): Promise<void> {
    await this.changeSchedules((entry) => {
      entry.obsidianBinding = binding;
    });
  }

  /**
   * Approves a note's schedule for a runner on this computer, as the note is
   * now, or withdraws its approval with null (#301). Approving again, and
   * handing over, ask only about what changed (#299): a dialog opens when a
   * permission changed or needs an answer, else nothing is asked. Returns
   * whether the approval was given.
   */
  async setScheduleOwner(path: string, owner: ScheduleOwner | null): Promise<boolean> {
    if (owner === null) {
      await this.changeSchedules((entry) => {
        revokeNote(entry, path);
      });
      await this.refreshAgentStatus();
      return true;
    }
    let note: ScheduledNoteNow;
    try {
      note = await this.readNoteNow(path);
    } catch (err) {
      new Notice(`VaultOre: could not approve ${path}: ${errorMessage(err)}`);
      return false;
    }
    const review = reviewApproval(approvalOf(this.schedules, path), note);
    let answers: Partial<Record<ApprovalPermissionKey, "allow" | "deny">> = {};
    if (needsReview(review)) {
      const given = await this.askForReview(path, owner, review);
      if (given === null) return false;
      answers = given;
    }
    let approved = false;
    await this.changeSchedules((entry) => {
      // As reviewed: a change to the approval meanwhile (vaultore, another
      // window) is reviewed again, not overwritten.
      if (JSON.stringify(reviewApproval(approvalOf(entry, path), note)) !== JSON.stringify(review)) {
        throw new Error(`the approval of ${path} changed while you reviewed it; review it again`);
      }
      approveNote(entry, note, owner, approvedPermissions(review, answers));
      approved = true;
    });
    await this.refreshAgentStatus();
    return approved;
  }

  /** Shows what changed, and asks for the answers an approval needs; null when cancelled. */
  askForReview(
    path: string,
    owner: ScheduleOwner,
    review: ApprovalReview
  ): Promise<Partial<Record<ApprovalPermissionKey, "allow" | "deny">> | null> {
    return new Promise((resolve) => new ReviewModal(this.app, path, owner, review, resolve).open());
  }

  private async dropScheduleApproval(path: string): Promise<void> {
    if (own(this.schedules.notes, path) === undefined) return;
    await this.changeSchedules((entry) => {
      revokeNote(entry, path);
    });
  }

  // The note's schedule, or undefined when it is not a scheduled workflow.
  private scheduleOf(file: TFile): string | undefined {
    const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
    if (!isWorkflowFrontmatter(frontmatter)) return undefined;
    const schedule: unknown = frontmatter?.schedule;
    if (schedule === undefined || schedule === null || schedule === "") return undefined;
    // A non-string schedule is kept in its YAML-ish form, so the list shows it
    // as invalid instead of dropping the note.
    return typeof schedule === "string" ? schedule : JSON.stringify(schedule);
  }

  // True when the switch is on, the note is Obsidian's to run (#301), the user
  // approved this exact schedule for the path, and the note still carries it.
  private isApprovedSchedule(path: string, schedule: string): boolean {
    const now = this.scheduledNow.get(path);
    if (typeof now !== "object" || now.schedule !== schedule) return false;
    if (noteScheduleState("obsidian", this.schedules, now).state !== "approved") return false;
    const file = this.app.vault.getAbstractFileByPath(path);
    return file instanceof TFile && this.scheduleOf(file) === schedule;
  }

  /**
   * Arms exactly the approved notes. Only entries whose schedule or approval
   * changed are unregistered or registered; every other timer keeps its
   * nextRun, so editing notes does not push due runs back.
   */
  private refreshScheduledWorkflows(): void {
    const wanted = new Map<string, string>();
    for (const note of this.getScheduledNotes()) {
      if (note.error !== undefined) {
        this.reportInvalidSchedule(note.path, note.schedule, note.error);
        continue;
      }
      const now = this.scheduledNow.get(note.path);
      // Armed once read: the approval binds the note's content and permissions (#299).
      if (typeof now === "object" && now.schedule === note.schedule && noteScheduleState("obsidian", this.schedules, now).state === "approved") {
        wanted.set(note.path, note.schedule);
      }
    }

    for (const entry of this.scheduler.list()) {
      if (wanted.get(entry.path) !== entry.cronExpression) {
        this.scheduler.unregister(entry.path);
      }
    }
    const registered = new Set(this.scheduler.list().map((entry) => entry.path));
    let armed = false;
    for (const [path, schedule] of wanted) {
      if (!registered.has(path)) {
        const entry = this.scheduler.register(path, schedule);
        armed = true;
        // Armed now: what it missed while it was not (#269).
        void this.lookForMissedRuns(path, schedule, entry.armedAt);
      }
    }
    // An occurrence of the last two minutes fires now, in time, rather than
    // at the next tick, when it would be late.
    if (armed) this.scheduler.tick();
  }

  /**
   * Records the runs of a scheduled note that no runner fired, and says so
   * once, for the gaps this runner recorded. Never fails the caller.
   */
  async lookForMissedRuns(path: string, schedule: string, armedAt?: Date): Promise<void> {
    try {
      // Since when it is scheduled: no run before is missed, also when its
      // last decision is no longer in the record (#308).
      const since = scheduledSince(this.schedules, path);
      await recordMissedSlots({
        vaultRoot: await this.adapter.getVaultRoot(),
        notePath: path,
        schedule,
        by: "Obsidian",
        keepDays: this.settings.scheduleHistoryDays,
        lateAfterMs: this.scheduler.lateAfterMs,
        ...(since ? { scheduledSince: since } : armedAt ? { armedAt } : {}),
      });
    } catch (err) {
      this.adapter.log("warn", `Could not look for missed runs of ${path}: ${errorMessage(err)}`);
    }
    // Also when the agent recorded the gap first: the user hears of it here.
    await this.refreshMissedRuns();
  }

  /**
   * A gap listed here may have been resolved by the other runner. Obsidian
   * draws the settings tab again only on update() (1.15.1), so the list is
   * re-read each minute while it holds a gap; quiet, as load told of errors.
   */
  async recheckMissedRuns(): Promise<void> {
    if (this.missedRuns.length > 0) await this.refreshMissedRuns(true);
  }

  // Open gaps this load of the plugin has told the user of, as "note slot".
  private announcedMissedRuns = new Set<string>();

  /** Reads the vault's open missed runs, and tells of each new one once. */
  async refreshMissedRuns(quiet = false): Promise<void> {
    try {
      const entries = await readSlotRecord({ vaultRoot: await this.adapter.getVaultRoot() });
      const before = this.missedRuns.map((gap) => `${gap.note} ${gap.slot.toISOString()}`).join("\n");
      this.missedRuns = entries.filter((entry) => entry.kind === "missed" && entry.state === "missed");
      const after = this.missedRuns.map((gap) => `${gap.note} ${gap.slot.toISOString()}`).join("\n");
      if (after !== before) this.settingsTab?.update();
    } catch (err) {
      if (!quiet) this.adapter.log("warn", `Could not read the schedule record: ${errorMessage(err)}`);
      return;
    }
    for (const gap of this.missedRuns) {
      const key = `${gap.note} ${gap.slot.toISOString()}`;
      if (this.announcedMissedRuns.has(key)) continue;
      this.announcedMissedRuns.add(key);
      new Notice(
        `VaultOre: ${gap.note} missed ${gap.count ?? 1} scheduled run(s) since ${gap.slot.toLocaleString()}. ` +
          "Catch up or dismiss them in VaultOre's settings."
      );
    }
  }

  /**
   * Runs a note once for a gap of missed runs. It stands in for the
   * scheduled run, so it runs with the note's approval, under its owner's
   * binding, and asks nothing (#299).
   */
  async catchUpMissedRun(gap: SlotEntry): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(gap.note);
    if (!(file instanceof TFile)) {
      new Notice(`VaultOre: ${gap.note} no longer exists; dismiss its missed runs instead`);
      return;
    }
    // Before the gap is taken: a catch-up that could not start would leave it
    // taken and not run.
    if (this.runningWorkflows.has(file.path)) {
      new Notice("VaultOre: Workflow is already running; catch up once it ends");
      return;
    }
    let unattended: UnattendedApproval;
    try {
      await this.reloadSchedules();
      if (this.schedulesError !== undefined) throw new Error(`the schedules cannot be read (${this.schedulesError})`);
      const note = await this.readNoteNow(file.path);
      const approval = approvalOf(this.schedules, file.path);
      if (approval === undefined) throw new Error("it is not approved to run on schedule; approve it under Scheduled workflows first");
      const refused = catchUpRefusal(this.schedules, approval);
      if (refused !== undefined) throw new Error(refused);
      const binding = bindingOf(this.schedules, approval.owner);
      if (!approvalCovers(approval, note, binding)) {
        throw new Error("it changed since it was approved; review it under Scheduled workflows first");
      }
      unattended = { approval, binding };
    } catch (err) {
      new Notice(`VaultOre: not catching up ${gap.note}: ${errorMessage(err)}`);
      return;
    }
    let claim: SlotClaim;
    try {
      claim = await catchUpMissedSlot({
        vaultRoot: await this.adapter.getVaultRoot(),
        notePath: gap.note,
        slot: gap.slot,
        by: "Obsidian",
      });
    } catch (err) {
      new Notice(err instanceof MissedSlotError ? `VaultOre: ${err.message}` : `VaultOre error: ${errorMessage(err)}`);
      await this.refreshMissedRuns();
      return;
    }
    await this.refreshMissedRuns();
    await this.runWorkflow(file, undefined, claim, unattended);
  }

  /** Closes a gap of missed runs without running the note. */
  async dismissMissedRun(gap: SlotEntry): Promise<void> {
    try {
      await dismissMissedSlots({
        vaultRoot: await this.adapter.getVaultRoot(),
        notePath: gap.note,
        slot: gap.slot,
        by: "Obsidian",
      });
    } catch (err) {
      new Notice(err instanceof MissedSlotError ? `VaultOre: ${err.message}` : `VaultOre error: ${errorMessage(err)}`);
    }
    await this.refreshMissedRuns();
  }

  private reportInvalidSchedule(path: string, schedule: string, error: string): void {
    const key = `${path}\n${schedule}`;
    if (this.reportedInvalidSchedules.has(key)) return;
    this.reportedInvalidSchedules.add(key);
    const message = `VaultOre: ${path} has an invalid schedule "${schedule}" and will not run (${error})`;
    this.adapter.log("warn", message);
    new Notice(message);
  }

  private async runCellAtLine(
    file: TFile,
    line: number,
    options: { skipDependencies?: boolean } = {}
  ): Promise<void> {
    // Claim the path in the same turn as the check. Reading and parsing below
    // both await, so a check-then-later-add left a window in which a second
    // invocation passed the guard and the cell ran twice. Every early return
    // from here on has to release it.
    if (this.runningWorkflows.has(file.path)) {
      new Notice("VaultOre: Workflow is already running");
      return;
    }
    this.runningWorkflows.add(file.path);

    let content: string;
    let workflow;
    let cell;
    try {
      content = await this.app.vault.read(file);
      workflow = this.parser.parse(content, file.path);
      cell = workflow.cells.find((c) => line >= c.startLine && line <= c.endLine);
    } catch (err) {
      this.runningWorkflows.delete(file.path);
      new Notice(`VaultOre: Parse error: ${errorMessage(err)}`);
      return;
    }

    if (!cell) {
      this.runningWorkflows.delete(file.path);
      new Notice("VaultOre: No cell found at cursor");
      return;
    }
    const startNotice = new Notice(`VaultOre: Running cell ${cell.attributes.id}...`, 0);

    try {
      const ran: string[] = [];
      const workflow = await this.executor.runWorkflow({
        platform: this.adapter,
        workflowPath: file.path,
        content,
        targetCellId: cell.attributes.id,
        skipDependencies: options.skipDependencies,
        emitEvent: (event, data) => {
          if (event === "cell:started") {
            const cellId = (data as { cellId?: string })?.cellId;
            if (cellId) {
              ran.push(cellId);
              startNotice.setMessage(`VaultOre: Running cell ${cellId}...`);
            }
          }
        },
      });
      startNotice.hide();
      new Notice(`VaultOre: ${describeRun(`Cell ${cell.attributes.id}`, summarizeRun(workflow.cells, workflow.outputs, ran))}`);
    } catch (err) {
      startNotice.hide();
      new Notice(runFailureNotice(err));
    } finally {
      this.runningWorkflows.delete(file.path);
    }
  }
}

/**
 * What a run that did not complete shows. A note another runner is running is
 * not an error of this one: the notice says who has it.
 */
function runFailureNotice(err: unknown): string {
  return err instanceof RunLockHeldError
    ? `VaultOre: ${err.message}`
    : `VaultOre error: ${errorMessage(err)}`;
}

type NumericSetting = "aiTemperature" | "aiMaxTokens" | "aiTimeoutSeconds" | "scheduleHistoryDays" | "lateAfterMinutes";

// Blank means "the default", which a number control cannot hold, so these are
// text controls that take a number in range or nothing.
const NUMERIC_SETTINGS: Record<NumericSetting, { valid: (n: number) => boolean; hint: string }> = {
  aiTemperature: { valid: (n) => n >= 0 && n <= 2, hint: "a number from 0 to 2" },
  aiMaxTokens: { valid: (n) => n > 0, hint: "a number above 0" },
  aiTimeoutSeconds: { valid: (n) => n > 0, hint: "a number of seconds above 0" },
  scheduleHistoryDays: {
    valid: (n) => Number.isInteger(n) && n >= 0 && n <= MAX_KEEP_DAYS,
    hint: `a whole number of days from 0 to ${MAX_KEEP_DAYS}`,
  },
  lateAfterMinutes: {
    valid: (n) => Number.isInteger(n) && n >= 2 && n <= 60,
    hint: "a whole number of minutes from 2 to 60",
  },
};

function isNumericSetting(key: string): key is NumericSetting {
  return Object.prototype.hasOwnProperty.call(NUMERIC_SETTINGS, key);
}

// The numeric settings kept in data.json; Late after is this machine's (#269).
type StoredNumericSetting = Exclude<NumericSetting, "lateAfterMinutes">;

function isStoredNumericSetting(key: string): key is StoredNumericSetting {
  return isNumericSetting(key) && key !== "lateAfterMinutes";
}

/** The number a numeric field holds: undefined when blank, null when invalid. */
function parseNumericSetting(key: NumericSetting, raw: string): number | undefined | null {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && NUMERIC_SETTINGS[key].valid(parsed) ? parsed : null;
}

/** What changed in a note since its approval, in a few words (#299). */
export function describeChange(approval: NoteApproval, note: { schedule: string }, review: ApprovalReview): string {
  const parts: string[] = [];
  if (approval.schedule !== note.schedule) parts.push(`schedule was "${approval.schedule}"`);
  for (const p of review.permissions) {
    if (p.status === "needs-answer") parts.push(`${p.key} now asks`);
    else if (p.status === "changed" || p.status === "answer-dropped") parts.push(`${p.key} is now ${p.now}`);
  }
  return parts.length > 0 ? parts.join(", ") : "its frontmatter or a cell";
}

/** Who runs the note on this computer, as the row's dropdown shows it. */
function ownerChoice(note: ScheduledNote): "off" | ScheduleOwner {
  return note.approval?.owner ?? "off";
}

const OWNER_CHOICES: Record<"off" | ScheduleOwner, string> = {
  off: "Off",
  obsidian: "In Obsidian",
  agent: "By the agent",
};

class VaultOreSettingsTab extends PluginSettingTab {
  plugin: VaultOrePlugin;

  constructor(app: App, plugin: VaultOrePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  // Obsidian renders the tab from these and indexes them for its settings
  // search. It calls this on every display and once when the tab is added.
  getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      {
        type: "group",
        heading: "AI",
        items: [
          {
            name: "Default provider",
            desc: createFragment((f) => {
              f.appendText("Provider used for ");
              f.createEl("code", { text: "ore:ai" });
              f.appendText(" cells.");
            }),
            control: {
              type: "dropdown",
              key: "defaultProvider",
              options: { openai: "OpenAI", anthropic: "Anthropic" },
            },
          },
          {
            name: "Default model",
            desc: "Model used for AI cells when none is specified.",
            control: { type: "text", key: "defaultModel" },
          },
          this.numericSetting(
            "aiTemperature",
            "Temperature",
            "Leave blank to use provider defaults. Some models ignore temperature.",
            "Provider default"
          ),
          this.numericSetting(
            "aiMaxTokens",
            "Max tokens",
            "Controls response length. Leave blank to use provider defaults.",
            "800"
          ),
          this.numericSetting(
            "aiTimeoutSeconds",
            "AI request timeout",
            "Seconds before an AI request is abandoned. Blank uses 120.",
            "120"
          ),
        ],
      },
      {
        type: "group",
        heading: "Execution",
        items: [
          {
            name: "Default runtime engine",
            desc:
              "Container runtime used for cell execution. A workflow that sets " +
              "runtime.engine in its frontmatter overrides this.",
            control: {
              type: "dropdown",
              key: "runtimeEngine",
              options: {
                docker: "Docker",
                podman: "Podman",
                colima: "Colima",
                apple: "Apple container (macOS 26+)",
              },
            },
          },
          {
            name: "Output folder",
            desc: "Where run outputs are stored. Use a visible folder (e.g. _vaultore) to make links clickable.",
            control: { type: "text", key: "outputRoot", placeholder: "_vaultore" },
          },
        ],
      },
      {
        type: "group",
        heading: "API keys",
        items: [this.secretSetting("openaiSecretName"), this.secretSetting("anthropicSecretName")],
      },
      {
        type: "group",
        heading: "Scheduled workflows",
        items: this.scheduleSettings(),
      },
      ...(this.plugin.missedRuns.length > 0
        ? [{ type: "group" as const, heading: "Missed runs", items: this.missedRunSettings() }]
        : []),
    ];
  }

  getControlValue(key: string): unknown {
    if (key === "lateAfterMinutes") {
      const value = this.plugin.lateAfterMinutes;
      return value === undefined ? "" : String(value);
    }
    if (isStoredNumericSetting(key)) {
      const value = this.plugin.settings[key];
      return value === undefined ? "" : String(value);
    }
    if (key === "runScheduledWorkflows") return this.plugin.schedules.obsidianScheduling;
    if (key === "obsidianBinding") return this.plugin.schedules.obsidianBinding;
    return (this.plugin.settings as unknown as Record<string, unknown>)[key];
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    const { settings } = this.plugin;
    switch (key) {
      case "runScheduledWorkflows":
        await this.plugin.setRunScheduledWorkflows(value === true);
        // The note rows describe whether and when they run.
        this.update();
        return;
      case "obsidianBinding":
        await this.plugin.setObsidianBinding(value === "narrow" ? "narrow" : "strict");
        this.update();
        return;
      case "defaultProvider": {
        const previous = settings.defaultProvider;
        settings.defaultProvider = value as VaultOreSettings["defaultProvider"];
        // The old provider's default would fail every AI cell under the new
        // one (#115); a model the user chose stays.
        if (settings.defaultModel === DEFAULT_MODELS[previous]) {
          settings.defaultModel = DEFAULT_MODELS[settings.defaultProvider];
          await this.plugin.saveSettings();
          this.update();
          return;
        }
        break;
      }
      case "defaultModel":
        settings.defaultModel = String(value).trim() || DEFAULT_MODELS[settings.defaultProvider];
        break;
      case "runtimeEngine":
        settings.runtimeEngine = value as VaultOreSettings["runtimeEngine"];
        break;
      case "outputRoot": {
        const trimmed = String(value).trim().replace(/^\/+/, "").replace(/\/+$/, "");
        settings.outputRoot = trimmed || "_vaultore";
        break;
      }
      case "lateAfterMinutes":
        try {
          // validate() has refused an invalid value before it gets here.
          await this.plugin.setLateAfterMinutes(parseNumericSetting(key, String(value)) ?? undefined);
        } catch (err) {
          new Notice(`VaultOre: could not save Late after: ${errorMessage(err)}`);
        }
        return;
      default:
        if (!isStoredNumericSetting(key)) {
          throw new Error(`VaultOre has no setting "${key}"`);
        }
        // validate() has refused an invalid value before it gets here.
        settings[key] = parseNumericSetting(key, String(value)) ?? undefined;
    }
    await this.plugin.saveSettings();
  }

  private numericSetting(
    key: NumericSetting,
    name: string,
    desc: string,
    placeholder: string
  ): SettingDefinition {
    return {
      name,
      desc,
      control: {
        type: "text",
        key,
        placeholder,
        validate: (value: string) =>
          parseNumericSetting(key, value) === null
            ? `Enter ${NUMERIC_SETTINGS[key].hint}, or leave it blank.`
            : undefined,
      },
    };
  }

  // A secret setting holds the name of an entry in Obsidian's secret storage,
  // as the "Store secrets" guide prescribes; the value is read at run time.
  // Rendered by hand: the row also says whether the secret exists and offers
  // Clear, which a control cannot.
  private secretSetting(key: SecretNameSetting): SettingDefinition {
    const label = Object.values(SECRET_SETTINGS).find((spec) => spec.setting === key)?.label;
    if (!label) {
      throw new Error(`No API key setting is defined for "${key}"`);
    }
    return {
      name: label,
      desc: "The name of a secret in Obsidian's secret storage.",
      render: (setting: Setting) => {
        let secret: SecretComponent | undefined;
        const describe = () => setting.setDesc(this.describeSecret(this.plugin.settings[key]));
        describe();
        setting
          .addComponent((el) => {
            secret = new SecretComponent(this.app, el)
              .setValue(this.plugin.settings[key])
              // Typed `string` up to obsidian 1.13 and `string | null` from 1.14,
              // where null means the selection was cleared.
              .onChange(async (value: string | null) => {
                this.plugin.settings[key] = value ?? "";
                await this.plugin.saveSettings();
                describe();
              });
            return secret;
          })
          .addButton((button) => {
            button.setButtonText("Clear");
            button.setTooltip("Clear the selection. The secret stays in Obsidian's secret storage.");
            button.onClick(async () => {
              this.plugin.settings[key] = "";
              await this.plugin.saveSettings();
              secret?.setValue("");
              describe();
            });
          });
      },
    };
  }

  private describeSecret(name: string): string {
    if (!name) {
      return "No secret selected. Select or create one in Obsidian's secret storage.";
    }
    const value = this.app.secretStorage.getSecret(name);
    if (!value?.trim()) {
      return `The secret "${name}" is missing or empty in Obsidian's secret storage.`;
    }
    return `Uses the secret "${name}" from Obsidian's secret storage.`;
  }

  private scheduleSettings(): SettingGroupItem[] {
    const items: SettingGroupItem[] = [
      {
        name: "Run scheduled workflows",
        desc:
          "Off by default, and set for each account on each computer. When on, a workflow note runs on its schedule while Obsidian " +
          "is open, but only if you approved it below." +
          (this.plugin.scheduledBeforeUpgrade && !this.plugin.schedules.obsidianScheduling
            ? " Before this version, scheduling was on for this vault; it is now off until you turn it on here."
            : "") +
          (this.plugin.schedulesError !== undefined
            ? ` Stopped: the schedules cannot be read (${this.plugin.schedulesError}).`
            : ""),
        control: { type: "toggle", key: "runScheduledWorkflows" },
      },
      {
        name: "What an approval covers",
        desc:
          "Strict: a note approved for Obsidian stops running on schedule when anything in it changes, until you review it. " +
          "Narrow: only a change of its schedule or permissions stops it; its cells may change, and run unreviewed. " +
          "vaultore agent is always strict. For your account on this computer.",
        control: {
          type: "dropdown",
          key: "obsidianBinding",
          options: { strict: "Strict: the whole note", narrow: "Narrow: schedule and permissions" },
        },
      },
      this.numericSetting(
        "scheduleHistoryDays",
        "Scheduled-run history",
        `Days Obsidian keeps what each scheduled run came to, from 0 to ${MAX_KEEP_DAYS}; the record is shared ` +
          "with vaultore agent, which keeps its own number of days (--keep-days), and the shorter one wins. " +
          "0 keeps each run for a day only. Blank keeps 30.",
        String(MAX_KEEP_DAYS)
      ),
      this.numericSetting(
        "lateAfterMinutes",
        "Late after",
        "Minutes a scheduled run may start late and still run, from 2 to 60; later, it is listed as missed. " +
          "For your account on this computer, shared with vaultore agent (vaultore schedules late-after). Blank is 2.",
        "2"
      ),
    ];

    items.push({
      name: "vaultore agent",
      desc: this.describeAgent(),
      searchable: false,
    });

    const notes = this.plugin.getScheduledNotes();
    if (notes.length === 0) {
      items.push({
        name: "No scheduled workflows found",
        desc: createFragment((f) => {
          f.appendText("Notes with ");
          f.createEl("code", { text: "ore: true" });
          f.appendText(" and a ");
          f.createEl("code", { text: "schedule" });
          f.appendText(" in their frontmatter are listed here.");
        }),
        searchable: false,
      });
      return items;
    }

    for (const note of notes) {
      items.push({
        name: note.path,
        desc: this.describeSchedule(note),
        // Note paths come and go with the vault; search indexes the settings.
        searchable: false,
        // Rendered by hand: Obsidian does not redraw the description of the
        // row whose own control changed, even after update(), and this row's
        // description follows its dropdown.
        render: (setting: Setting) => {
          setting.setDesc(this.describeSchedule(note));
          setting.addDropdown((dropdown) => {
            for (const [value, label] of Object.entries(OWNER_CHOICES)) dropdown.addOption(value, label);
            dropdown.setValue(ownerChoice(note));
            dropdown.setDisabled(note.error !== undefined);
            dropdown.onChange(async (value) => {
              await this.plugin.setScheduleOwner(note.path, value === "off" ? null : (value as ScheduleOwner));
              const current =
                this.plugin.getScheduledNotes().find((entry) => entry.path === note.path) ?? note;
              // A review cancelled leaves the approval as it was.
              dropdown.setValue(ownerChoice(current));
              setting.setDesc(this.describeSchedule(current));
            });
          });
          // Changed since approved: reviewing approves it again for its owner (#299).
          const owner = note.approval?.owner;
          if (note.state?.state === "changed" && owner !== undefined) {
            setting.addButton((button) =>
              button.setButtonText("Review").onClick(async () => {
                if (await this.plugin.setScheduleOwner(note.path, owner)) this.update();
              })
            );
          }
        },
      });
    }
    return items;
  }

  // Scheduled runs no runner fired, one row per gap, with what to do (#269).
  private missedRunSettings(): SettingGroupItem[] {
    return this.plugin.missedRuns.map((gap) => {
      const count = gap.count ?? 1;
      const from = gap.slot.toLocaleString();
      const to = (gap.until ?? gap.slot).toLocaleString();
      return {
        name: gap.note,
        desc:
          count === 1
            ? `The run of ${from} was missed.`
            : `${count} scheduled runs from ${from} to ${to} were missed. Catching up runs the note once.`,
        searchable: false,
        render: (setting: Setting) => {
          setting.addButton((button) =>
            button.setButtonText("Catch up").onClick(async () => {
              await this.plugin.catchUpMissedRun(gap);
              this.update();
            })
          );
          setting.addButton((button) =>
            button.setButtonText("Dismiss").onClick(async () => {
              await this.plugin.dismissMissedRun(gap);
              this.update();
            })
          );
        },
      };
    });
  }

  // Whether vaultore agent runs this vault, for the notes handed to it (#301).
  private describeAgent(): string {
    const status = this.plugin.agentStatus;
    const handed = Object.values(this.plugin.schedules.notes).filter((approval) => approval.owner === "agent").length;
    const notes = handed === 1 ? "the note handed to it" : `the ${handed} notes handed to it`;
    const run = handed === 1 ? "does not run" : "do not run";
    if (status === undefined) return "Whether it runs this vault could not be read.";
    if (status.state === "running") {
      return `Runs this vault since ${new Date(status.holder.since).toLocaleString()} (process ${status.holder.pid})` +
        (handed > 0 ? `, and with it ${notes}.` : "; no note is handed to it.");
    }
    if (status.state === "unknown") {
      return `Holds this vault from ${status.holder.host}, which this computer cannot check.`;
    }
    return handed > 0
      ? `Does not run this vault, so ${notes} ${run}. Start it with: vaultore agent --vault <this vault>.`
      : "Does not run this vault. Notes set to \"By the agent\" run only while it does.";
  }

  private describeSchedule(note: ScheduledNote): string {
    const schedule = `Schedule "${note.schedule}"`;
    if (note.error !== undefined) {
      return `${schedule} is invalid, so this note does not run: ${note.error}`;
    }
    const approval = note.approval;
    if (approval === undefined) {
      return `${schedule}. Not approved, so it does not run.`;
    }
    const state = note.state;
    if (state === undefined) return `${schedule}. Approved for ${ownerName(approval.owner)}; reading the note.`;
    if (state.state === "changed") {
      // Copied from 0.4.x, whose approvals held no answers: nothing changed (#310).
      if (approval.permissions === undefined && state.review.needsAnswer.length > 0) {
        const asks = state.review.needsAnswer.join(", ");
        return `${schedule}. Handed to ${ownerName(approval.owner)} by an earlier version, whose approvals held no answers; ${asks} ${state.review.needsAnswer.length === 1 ? "asks" : "ask"}, so it does not run until you answer. Review it to answer.`;
      }
      const where = approval.owner === "agent" ? "Handed to vaultore agent, but it" : "It";
      return `${schedule}. ${where} changed since it was approved (${describeChange(approval, note, state.review)}), so it does not run. Review it to run it again.`;
    }
    if (approval.owner === "agent") {
      return this.plugin.agentStatus?.state === "running"
        ? `${schedule}. Runs in vaultore agent.`
        : `${schedule}. Handed to vaultore agent, which does not run this vault now.`;
    }
    if (!this.plugin.schedules.obsidianScheduling) {
      return `${schedule}. Approved for Obsidian; runs once "Run scheduled workflows" is on.`;
    }
    if (!note.nextRun) {
      return `${schedule}. Approved for Obsidian; not armed yet.`;
    }
    return `${schedule}. Next run: ${note.nextRun.toLocaleString()}.`;
  }
}
