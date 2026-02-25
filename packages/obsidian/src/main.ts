import {
  App,
  Modal,
  Plugin,
  PluginSettingTab,
  Setting,
  Notice,
  TFile,
  SecretComponent,
} from "obsidian";
import { WorkflowExecutor, WorkflowParser, WorkflowScheduler } from "@vaultore/core";
import type { PlatformAdapter } from "@vaultore/core";

interface VaultOreSettings {
  defaultProvider: "openai" | "anthropic";
  defaultModel: string;
  aiTemperature?: number;
  aiMaxTokens?: number;
  runtimeEngine: "docker" | "podman" | "colima";
  permissionDecisions: Record<string, any>;
  enableWarmPool: boolean;
  outputRoot: string;
}

const DEFAULT_SETTINGS: VaultOreSettings = {
  defaultProvider: "openai",
  defaultModel: "gpt-5-mini",
  aiMaxTokens: 800,
  runtimeEngine: "docker",
  permissionDecisions: {},
  enableWarmPool: false,
  outputRoot: "_vaultore",
};

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
    // @ts-expect-error - Obsidian adapter provides getBasePath on desktop
    return this.plugin.app.vault.adapter.getBasePath();
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
      case "vaultore.runtimeEngine":
        return this.plugin.settings.runtimeEngine as T;
      case "vaultore.permissionDecisions":
        return this.plugin.settings.permissionDecisions as T;
      case "vaultore.enableWarmPool":
        return this.plugin.settings.enableWarmPool as T;
      case "vaultore.outputRoot":
        return this.plugin.settings.outputRoot as T;
      default:
        return (this.plugin.settings as Record<string, any>)[key];
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
      case "vaultore.runtimeEngine":
        this.plugin.settings.runtimeEngine = value as VaultOreSettings["runtimeEngine"];
        break;
      case "vaultore.permissionDecisions":
        this.plugin.settings.permissionDecisions = value as Record<string, any>;
        break;
      case "vaultore.enableWarmPool":
        this.plugin.settings.enableWarmPool = value as boolean;
        break;
      case "vaultore.outputRoot":
        this.plugin.settings.outputRoot = value as string;
        break;
      default:
        (this.plugin.settings as Record<string, any>)[key] = value;
    }
    await this.plugin.saveSettings();
  }

  async getSecret(key: string): Promise<string | undefined> {
    const storage = this.plugin.app.secretStorage;
    if (!storage) return undefined;
    const value = storage.getSecret(this.secretIdFor(key));
    if (!value) return undefined;
    return value;
  }

  async setSecret(key: string, value: string): Promise<void> {
    const storage = this.plugin.app.secretStorage;
    if (!storage) {
      throw new Error("Secret storage not available in this Obsidian version");
    }
    storage.setSecret(this.secretIdFor(key), value);
  }

  async deleteSecret(key: string): Promise<void> {
    const storage = this.plugin.app.secretStorage;
    if (!storage) {
      throw new Error("Secret storage not available in this Obsidian version");
    }
    const secretId = this.secretIdFor(key);
    const existing = storage.getSecret(secretId);
    if (existing == null) return;
    storage.setSecret(secretId, "");
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
        console.debug("[VaultOre]", payload);
        break;
      case "info":
        console.info("[VaultOre]", payload);
        break;
      case "warn":
        console.warn("[VaultOre]", payload);
        break;
      case "error":
        console.error("[VaultOre]", payload);
        break;
    }
  }

  private secretIdFor(key: string): string {
    const normalized = key
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "");
    return `vaultore-${normalized}`;
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
      workflows.forEach((workflow) => this.runWorkflowByPath(workflow.path));
    },
  });
  private schedulerRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private runningWorkflows = new Set<string>();

  async onload(): Promise<void> {
    await this.loadSettings();
    this.adapter = new ObsidianAdapter(this);

    this.addCommand({
      id: "vaultore-run-all",
      name: "Run All Cells",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== "md") return false;
        if (!checking) {
          void this.runWorkflow(file);
        }
        return true;
      },
    });

    this.addCommand({
      id: "vaultore-run-cell",
      name: "Run Cell",
      editorCallback: async (editor, view) => {
        const file = view.file;
        if (!file) return;
        const line = editor.getCursor().line + 1;
        await this.runCellAtLine(file, line);
      },
    });

    this.addCommand({
      id: "vaultore-run-cell-only",
      name: "Run Cell Only (Skip Dependencies)",
      editorCallback: async (editor, view) => {
        const file = view.file;
        if (!file) return;
        const line = editor.getCursor().line + 1;
        await this.runCellAtLine(file, line, { skipDependencies: true });
      },
    });

    this.addSettingTab(new VaultOreSettingsTab(this.app, this));

    this.scheduler.start();
    await this.refreshScheduledWorkflows();

    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (file instanceof TFile && file.extension === "md") {
          this.debouncedRefreshScheduledWorkflows();
        }
      })
    );
  }

  onunload(): void {
    this.scheduler.stop();
    if (this.schedulerRefreshTimer !== null) {
      clearTimeout(this.schedulerRefreshTimer);
      this.schedulerRefreshTimer = null;
    }
  }

  async loadSettings(): Promise<void> {
    const data = (await this.loadData()) as Partial<VaultOreSettings> | null;
    this.settings = { ...DEFAULT_SETTINGS, ...(data ?? {}) };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  async setSecretValue(key: string, value: string): Promise<void> {
    await this.adapter.setSecret(key, value);
  }

  async deleteSecretValue(key: string): Promise<void> {
    await this.adapter.deleteSecret(key);
  }

  private async runWorkflow(file: TFile): Promise<void> {
    if (this.runningWorkflows.has(file.path)) {
      new Notice("VaultOre: Workflow is already running");
      return;
    }

    this.runningWorkflows.add(file.path);
    const content = await this.app.vault.read(file);
    const startNotice = new Notice(`VaultOre: Running ${file.basename}...`, 0);

    try {
      await this.executor.runWorkflow({
        platform: this.adapter,
        workflowPath: file.path,
        content,
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
      new Notice("VaultOre: Workflow completed");
    } catch (err) {
      startNotice.hide();
      new Notice(`VaultOre error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
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
      clearTimeout(this.schedulerRefreshTimer);
    }
    this.schedulerRefreshTimer = setTimeout(() => {
      this.schedulerRefreshTimer = null;
      void this.refreshScheduledWorkflows();
    }, SCHEDULER_DEBOUNCE_MS);
  }

  private async refreshScheduledWorkflows(): Promise<void> {
    // Clear existing registrations without destroying the scheduler instance
    for (const entry of this.scheduler.list()) {
      this.scheduler.unregister(entry.path);
    }

    const files = this.app.vault.getMarkdownFiles();
    for (const file of files) {
      const content = await this.app.vault.read(file);
      if (!this.parser.isWorkflow(content)) continue;
      try {
        const workflow = this.parser.parse(content, file.path);
        if (workflow.frontmatter.schedule) {
          this.scheduler.register(file.path, workflow.frontmatter.schedule);
        }
      } catch {
        // Skip files that fail to parse (e.g. malformed frontmatter)
      }
    }
  }

  private async runCellAtLine(
    file: TFile,
    line: number,
    options: { skipDependencies?: boolean } = {}
  ): Promise<void> {
    if (this.runningWorkflows.has(file.path)) {
      new Notice("VaultOre: Workflow is already running");
      return;
    }

    const content = await this.app.vault.read(file);
    let workflow;
    try {
      workflow = this.parser.parse(content, file.path);
    } catch (err) {
      new Notice(`VaultOre: Parse error: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    const cell = workflow.cells.find(
      (c) => line >= c.startLine && line <= c.endLine
    );

    if (!cell) {
      new Notice("VaultOre: No cell found at cursor");
      return;
    }

    this.runningWorkflows.add(file.path);
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

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "VaultOre Settings" });

    new Setting(containerEl)
      .setName("Default AI Provider")
      .setDesc("Select the default AI provider for ore:ai cells.")
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
      .setName("Default Model")
      .setDesc("Default model used for AI cells when none is specified.")
      .addText((text) => {
        text.setValue(this.plugin.settings.defaultModel);
        text.onChange(async (value) => {
          this.plugin.settings.defaultModel =
            value.trim() || DEFAULT_SETTINGS.defaultModel;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("AI Temperature (Default)")
      .setDesc("Leave blank to use provider defaults. Some models ignore temperature.")
      .addText((text) => {
        text.setPlaceholder("provider default");
        text.setValue(
          this.plugin.settings.aiTemperature !== undefined
            ? String(this.plugin.settings.aiTemperature)
            : ""
        );
        text.onChange(async (value) => {
          const trimmed = value.trim();
          const parsed = trimmed ? Number(trimmed) : undefined;
          this.plugin.settings.aiTemperature =
            parsed !== undefined && Number.isFinite(parsed) ? parsed : undefined;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("AI Max Tokens (Default)")
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
            parsed !== undefined && Number.isFinite(parsed) ? parsed : undefined;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Runtime Engine")
      .setDesc("Container runtime used for cell execution.")
      .addDropdown((dropdown) => {
        dropdown.addOption("docker", "Docker");
        dropdown.addOption("podman", "Podman");
        dropdown.addOption("colima", "Colima");
        dropdown.setValue(this.plugin.settings.runtimeEngine);
        dropdown.onChange(async (value) => {
          this.plugin.settings.runtimeEngine = value as VaultOreSettings["runtimeEngine"];
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Warm Container Pool")
      .setDesc("Pre-start containers for faster execution (future feature).")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.enableWarmPool);
        toggle.onChange(async (value) => {
          this.plugin.settings.enableWarmPool = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Output Folder")
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

    new Setting(containerEl)
      .setName("OpenAI API Key")
      .setDesc("Stored in Obsidian SecretStorage.")
      .addComponent((el) => {
        const secret = new SecretComponent(this.app, el);
        secret.onChange((value) => {
          const trimmed = value.trim();
          if (!trimmed) return;
          void this.plugin
            .setSecretValue("openai.apiKey", trimmed)
            .then(() => {
              secret.setValue("");
              new Notice("VaultOre: OpenAI key saved");
            })
            .catch((err) => {
              new Notice(
                `VaultOre: Failed to save OpenAI key (${err instanceof Error ? err.message : String(err)})`
              );
            });
        });
        return secret;
      })
      .addButton((button) => {
        button.setButtonText("Clear");
        button.onClick(async () => {
          try {
            await this.plugin.deleteSecretValue("openai.apiKey");
            new Notice("VaultOre: OpenAI key removed");
          } catch (err) {
            new Notice(
              `VaultOre: Failed to remove OpenAI key (${err instanceof Error ? err.message : String(err)})`
            );
          }
        });
      });

    new Setting(containerEl)
      .setName("Anthropic API Key")
      .setDesc("Stored in Obsidian SecretStorage.")
      .addComponent((el) => {
        const secret = new SecretComponent(this.app, el);
        secret.onChange((value) => {
          const trimmed = value.trim();
          if (!trimmed) return;
          void this.plugin
            .setSecretValue("anthropic.apiKey", trimmed)
            .then(() => {
              secret.setValue("");
              new Notice("VaultOre: Anthropic key saved");
            })
            .catch((err) => {
              new Notice(
                `VaultOre: Failed to save Anthropic key (${err instanceof Error ? err.message : String(err)})`
              );
            });
        });
        return secret;
      })
      .addButton((button) => {
        button.setButtonText("Clear");
        button.onClick(async () => {
          try {
            await this.plugin.deleteSecretValue("anthropic.apiKey");
            new Notice("VaultOre: Anthropic key removed");
          } catch (err) {
            new Notice(
              `VaultOre: Failed to remove Anthropic key (${err instanceof Error ? err.message : String(err)})`
            );
          }
        });
      });
  }
}
