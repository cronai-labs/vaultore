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
import {
  DEFAULT_MODELS,
  DEFAULT_PROVIDER,
  WorkflowExecutor,
  WorkflowParser,
  WorkflowScheduler,
  computeNextRun,
  isWorkflowFrontmatter,
} from "@vaultore/core";
import type { PlatformAdapter, PlatformRequest, PlatformResponse } from "@vaultore/core";

interface VaultOreSettings {
  defaultProvider: "openai" | "anthropic";
  defaultModel: string;
  aiTemperature?: number;
  aiMaxTokens?: number;
  aiTimeoutSeconds?: number;
  runtimeEngine: "docker" | "podman" | "colima" | "apple";
  permissionDecisions: Record<string, unknown>;
  outputRoot: string;
  // Names of entries in Obsidian's secret storage, picked with a
  // SecretComponent. The keys themselves never enter data.json.
  openaiSecretName: string;
  anthropicSecretName: string;
  // Master switch for scheduled runs. Off by default: enabling the plugin, or
  // a note arriving through sync, must not start anything unattended.
  runScheduledWorkflows: boolean;
  // Notes the user approved to run on a schedule: note path → the exact
  // schedule approved. A changed schedule no longer matches and needs a new
  // approval. Kept here rather than in the notes, which sync can rewrite.
  scheduleApprovals: Record<string, string>;
}

// A workflow note with a schedule, as the settings tab lists it.
export interface ScheduledNote {
  path: string;
  schedule: string;
  // The schedule the user approved for this path, which may differ from the
  // note's current one.
  approvedSchedule?: string;
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
  permissionDecisions: {},
  outputRoot: "_vaultore",
  openaiSecretName: "",
  anthropicSecretName: "",
  runScheduledWorkflows: false,
  scheduleApprovals: {},
};

type SecretNameSetting = "openaiSecretName" | "anthropicSecretName";

// The secret keys core asks for, mapped to the setting that names the secret
// and the label the user sees on that setting.
const SECRET_SETTINGS: Record<string, { setting: SecretNameSetting; label: string }> = {
  "openai.apiKey": { setting: "openaiSecretName", label: "OpenAI API key" },
  "anthropic.apiKey": { setting: "anthropicSecretName", label: "Anthropic API key" },
};

// enableWarmPool: a "future feature" toggle that never did anything.
const REMOVED_SETTINGS = ["enableWarmPool"];

const SCHEDULER_DEBOUNCE_MS = 2000;

class ObsidianAdapter implements PlatformAdapter {
  readonly platform = "obsidian" as const;
  private plugin: VaultOrePlugin;

  constructor(plugin: VaultOrePlugin) {
    this.plugin = plugin;
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
        const message = err instanceof Error ? err.message : String(err);
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
      case "vaultore.permissionDecisions":
        return this.plugin.settings.permissionDecisions as T;
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
      case "vaultore.permissionDecisions":
        this.plugin.settings.permissionDecisions = value as Record<string, unknown>;
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
        const message = err instanceof Error ? err.message : String(err);
        if (!message.toLowerCase().includes("already exists")) {
          throw err;
        }
      }
    }
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
  private scheduler = new WorkflowScheduler({
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
        void this.runWorkflowByPath(workflow.path);
      }
    },
  });
  private schedulerRefreshTimer: number | null = null;
  private runningWorkflows = new Set<string>();
  // Invalid schedules already reported, as "path\nschedule", so a typo is
  // reported once rather than on every vault change.
  private reportedInvalidSchedules = new Set<string>();

  async onload(): Promise<void> {
    await this.loadSettings();
    this.adapter = new ObsidianAdapter(this);

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

    this.addSettingTab(new VaultOreSettingsTab(this.app, this));

    this.scheduler.start();

    // Defer the initial vault scan until the workspace layout (and metadata
    // cache) is ready, so plugin load stays fast on large vaults.
    this.app.workspace.onLayoutReady(() => {
      this.refreshScheduledWorkflows();
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
      // A fresh object, so approving a note never mutates DEFAULT_SETTINGS.
      scheduleApprovals: { ...(data?.scheduleApprovals ?? {}) },
    };
    // Settings that no longer exist, dropped so data.json stops carrying them.
    for (const key of REMOVED_SETTINGS) {
      delete (settings as Record<string, unknown>)[key];
    }
    this.settings = settings;
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  // Command checks run synchronously on every palette open, so they read the
  // metadata cache's parsed frontmatter rather than the note's text.
  private isWorkflowNote(file: TFile | null): file is TFile {
    if (!file || file.extension !== "md") return false;
    return isWorkflowFrontmatter(this.app.metadataCache.getFileCache(file)?.frontmatter);
  }

  private async runWorkflow(file: TFile): Promise<void> {
    if (this.runningWorkflows.has(file.path)) {
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
      startNotice = new Notice(`VaultOre: Running ${file.basename}...`, 0);

      await this.executor.runWorkflow({
        platform: this.adapter,
        workflowPath: file.path,
        content,
        emitEvent: (event, data) => {
          if (event === "cell:started") {
            const cellId = (data as { cellId?: string })?.cellId;
            if (cellId) {
              startNotice?.setMessage(`VaultOre: Running cell ${cellId}...`);
            }
          }
        },
      });
      new Notice("VaultOre: Workflow completed");
    } catch (err) {
      new Notice(`VaultOre error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      // The notice is only created once the read succeeds, so it may not exist.
      startNotice?.hide();
      this.runningWorkflows.delete(file.path);
    }
  }

  private async runWorkflowByPath(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      await this.runWorkflow(file);
    }
  }

  private debouncedRefreshScheduledWorkflows(): void {
    if (this.schedulerRefreshTimer !== null) {
      window.clearTimeout(this.schedulerRefreshTimer);
    }
    this.schedulerRefreshTimer = window.setTimeout(() => {
      this.schedulerRefreshTimer = null;
      this.refreshScheduledWorkflows();
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
        error = err instanceof Error ? err.message : String(err);
      }
      const entry = registered.get(file.path);
      notes.push({
        path: file.path,
        schedule,
        approvedSchedule: this.settings.scheduleApprovals[file.path],
        error,
        nextRun: entry?.cronExpression === schedule ? entry.nextRun : undefined,
      });
    }
    return notes.sort((a, b) => a.path.localeCompare(b.path));
  }

  async setRunScheduledWorkflows(enabled: boolean): Promise<void> {
    this.settings.runScheduledWorkflows = enabled;
    await this.saveSettings();
    this.refreshScheduledWorkflows();
  }

  /** Approve a note's schedule, or withdraw the approval with null. */
  async setScheduleApproval(path: string, schedule: string | null): Promise<void> {
    if (schedule === null) {
      delete this.settings.scheduleApprovals[path];
    } else {
      this.settings.scheduleApprovals[path] = schedule;
    }
    await this.saveSettings();
    this.refreshScheduledWorkflows();
  }

  private async dropScheduleApproval(path: string): Promise<void> {
    if (!(path in this.settings.scheduleApprovals)) return;
    delete this.settings.scheduleApprovals[path];
    await this.saveSettings();
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

  // True when the switch is on, the user approved this exact schedule for the
  // path, and the note still carries it.
  private isApprovedSchedule(path: string, schedule: string): boolean {
    if (!this.settings.runScheduledWorkflows) return false;
    if (this.settings.scheduleApprovals[path] !== schedule) return false;
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
      if (this.settings.runScheduledWorkflows && note.approvedSchedule === note.schedule) {
        wanted.set(note.path, note.schedule);
      }
    }

    for (const entry of this.scheduler.list()) {
      if (wanted.get(entry.path) !== entry.cronExpression) {
        this.scheduler.unregister(entry.path);
      }
    }
    const registered = new Set(this.scheduler.list().map((entry) => entry.path));
    for (const [path, schedule] of wanted) {
      if (!registered.has(path)) {
        this.scheduler.register(path, schedule);
      }
    }
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
      new Notice(`VaultOre: Parse error: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    if (!cell) {
      this.runningWorkflows.delete(file.path);
      new Notice("VaultOre: No cell found at cursor");
      return;
    }
    const startNotice = new Notice(`VaultOre: Running cell ${cell.attributes.id}...`, 0);

    try {
      await this.executor.runWorkflow({
        platform: this.adapter,
        workflowPath: file.path,
        content,
        targetCellId: cell.attributes.id,
        skipDependencies: options.skipDependencies,
        emitEvent: (event, data) => {
          if (event === "cell:started") {
            const cellId = (data as { cellId?: string })?.cellId;
            if (cellId) {
              startNotice.setMessage(`VaultOre: Running cell ${cellId}...`);
            }
          }
        },
      });
      startNotice.hide();
      new Notice(`VaultOre: Cell ${cell.attributes.id} completed`);
    } catch (err) {
      startNotice.hide();
      new Notice(`VaultOre error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.runningWorkflows.delete(file.path);
    }
  }
}

class VaultOreSettingsTab extends PluginSettingTab {
  plugin: VaultOrePlugin;

  constructor(app: App, plugin: VaultOrePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  // A secret setting holds the name of an entry in Obsidian's secret storage,
  // as the "Store secrets" guide prescribes; the value is read at run time.
  private addSecretSetting(containerEl: HTMLElement, key: SecretNameSetting): void {
    const label = Object.values(SECRET_SETTINGS).find((spec) => spec.setting === key)?.label;
    if (!label) {
      throw new Error(`No API key setting is defined for "${key}"`);
    }
    let secret: SecretComponent | undefined;
    const setting = new Setting(containerEl).setName(label);
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

  display(): void {
    this.render();
  }

  // Re-rendered after a scheduling change so statuses and next runs update.
  private render(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl).setName("AI").setHeading();

    new Setting(containerEl)
      .setName("Default provider")
      .setDesc(
        createFragment((f) => {
          f.appendText("Provider used for ");
          f.createEl("code", { text: "ore:ai" });
          f.appendText(" cells.");
        })
      )
      .addDropdown((dropdown) => {
        dropdown.addOption("openai", "OpenAI");
        dropdown.addOption("anthropic", "Anthropic");
        dropdown.setValue(this.plugin.settings.defaultProvider);
        dropdown.onChange(async (value) => {
          this.plugin.settings.defaultProvider = value as VaultOreSettings["defaultProvider"];
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Default model")
      .setDesc("Model used for AI cells when none is specified.")
      .addText((text) => {
        text.setValue(this.plugin.settings.defaultModel);
        text.onChange(async (value) => {
          this.plugin.settings.defaultModel =
            value.trim() || DEFAULT_MODELS[this.plugin.settings.defaultProvider];
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Temperature")
      .setDesc("Leave blank to use provider defaults. Some models ignore temperature.")
      .addText((text) => {
        text.setPlaceholder("Provider default");
        text.setValue(
          this.plugin.settings.aiTemperature !== undefined
            ? String(this.plugin.settings.aiTemperature)
            : ""
        );
        text.onChange(async (value) => {
          const trimmed = value.trim();
          const parsed = trimmed ? Number(trimmed) : undefined;
          this.plugin.settings.aiTemperature =
            parsed !== undefined && Number.isFinite(parsed) && parsed >= 0 && parsed <= 2
              ? parsed
              : undefined;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Max tokens")
      .setDesc("Controls response length. Leave blank to use provider defaults.")
      .addText((text) => {
        text.setPlaceholder("800");
        text.setValue(
          this.plugin.settings.aiMaxTokens !== undefined
            ? String(this.plugin.settings.aiMaxTokens)
            : ""
        );
        text.onChange(async (value) => {
          const trimmed = value.trim();
          const parsed = trimmed ? Number(trimmed) : undefined;
          this.plugin.settings.aiMaxTokens =
            parsed !== undefined && Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("AI request timeout")
      .setDesc("Seconds before an AI request is abandoned. Blank uses 120.")
      .addText((text) => {
        text.setPlaceholder("120");
        text.setValue(
          this.plugin.settings.aiTimeoutSeconds !== undefined
            ? String(this.plugin.settings.aiTimeoutSeconds)
            : ""
        );
        text.onChange(async (value) => {
          const trimmed = value.trim();
          const parsed = trimmed ? Number(trimmed) : undefined;
          this.plugin.settings.aiTimeoutSeconds =
            parsed !== undefined && Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl).setName("Execution").setHeading();

    new Setting(containerEl)
      .setName("Default runtime engine")
      .setDesc(
        "Container runtime used for cell execution. A workflow that sets " +
          "'engine:' in its frontmatter overrides this."
      )
      .addDropdown((dropdown) => {
        dropdown.addOption("docker", "Docker");
        dropdown.addOption("podman", "Podman");
        dropdown.addOption("colima", "Colima");
        dropdown.addOption("apple", "Apple container (macOS 26+)");
        dropdown.setValue(this.plugin.settings.runtimeEngine);
        dropdown.onChange(async (value) => {
          this.plugin.settings.runtimeEngine = value as VaultOreSettings["runtimeEngine"];
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Output folder")
      .setDesc(
        "Where run outputs are stored. Use a visible folder (e.g. _vaultore) to make links clickable."
      )
      .addText((text) => {
        text.setPlaceholder("_vaultore");
        text.setValue(this.plugin.settings.outputRoot);
        text.onChange(async (value) => {
          const trimmed = value.trim().replace(/^\/+/, "").replace(/\/+$/, "");
          this.plugin.settings.outputRoot = trimmed || "_vaultore";
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl).setName("API keys").setHeading();

    this.addSecretSetting(containerEl, "openaiSecretName");
    this.addSecretSetting(containerEl, "anthropicSecretName");

    this.displayScheduledWorkflows(containerEl);
  }

  private displayScheduledWorkflows(containerEl: HTMLElement): void {
    new Setting(containerEl).setName("Scheduled workflows").setHeading();

    new Setting(containerEl)
      .setName("Run scheduled workflows")
      .setDesc(
        "Off by default. When on, a workflow note runs on its schedule while Obsidian " +
          "is open, but only if you approved it below."
      )
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.runScheduledWorkflows);
        toggle.onChange(async (value) => {
          await this.plugin.setRunScheduledWorkflows(value);
          this.render();
        });
      });

    const notes = this.plugin.getScheduledNotes();
    if (notes.length === 0) {
      new Setting(containerEl).setDesc(
        createFragment((f) => {
          f.appendText("No scheduled workflows found. Notes with ");
          f.createEl("code", { text: "ore: true" });
          f.appendText(" and a ");
          f.createEl("code", { text: "schedule" });
          f.appendText(" in their frontmatter are listed here.");
        })
      );
      return;
    }

    for (const note of notes) {
      const approved = note.error === undefined && note.approvedSchedule === note.schedule;
      new Setting(containerEl)
        .setName(note.path)
        .setDesc(this.describeSchedule(note, approved))
        .addToggle((toggle) => {
          toggle.setValue(approved);
          toggle.setDisabled(note.error !== undefined);
          toggle.setTooltip(approved ? "Approved to run on schedule" : "Approve to run on schedule");
          toggle.onChange(async (value) => {
            await this.plugin.setScheduleApproval(note.path, value ? note.schedule : null);
            this.render();
          });
        });
    }
  }

  private describeSchedule(note: ScheduledNote, approved: boolean): string {
    const schedule = `Schedule "${note.schedule}"`;
    if (note.error !== undefined) {
      return `${schedule} is invalid, so this note does not run: ${note.error}`;
    }
    if (note.approvedSchedule !== undefined && !approved) {
      return (
        `Schedule changed from "${note.approvedSchedule}" to "${note.schedule}" since you ` +
        "approved it. Approve it again to run it."
      );
    }
    if (!approved) {
      return `${schedule}. Not approved, so it does not run.`;
    }
    if (!this.plugin.settings.runScheduledWorkflows) {
      return `${schedule}. Approved; runs once "Run scheduled workflows" is on.`;
    }
    if (!note.nextRun) {
      return `${schedule}. Approved; not armed yet.`;
    }
    return `${schedule}. Next run: ${note.nextRun.toLocaleString()}.`;
  }
}
