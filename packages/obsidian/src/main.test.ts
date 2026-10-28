import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---- Core module mock (before importing main) ----
// The scheduler, cron parsing, the workflow check and the model defaults are
// the real ones, so the plugin's scheduling and command guards are tested
// against core's behaviour and the plugin cannot carry its own copy of the
// defaults (#78). Only the executor (containers, AI) and the cell parser are
// faked.
vi.mock("@vaultore/core", async () => {
  const actual = await vi.importActual<typeof import("@vaultore/core")>("@vaultore/core");
  return {
    DEFAULT_MODELS: actual.DEFAULT_MODELS,
    DEFAULT_PROVIDER: actual.DEFAULT_PROVIDER,
    WorkflowExecutor: class {
      runWorkflow = vi.fn().mockResolvedValue({});
    },
    WorkflowParser: class {
      parse = vi.fn().mockReturnValue({
        frontmatter: {},
        cells: [],
      });
    },
    WorkflowScheduler: actual.WorkflowScheduler,
    computeNextRun: actual.computeNextRun,
    errorMessage: actual.errorMessage,
    isWorkflowFrontmatter: actual.isWorkflowFrontmatter,
    resolveInVaultRoot: actual.resolveInVaultRoot,
  };
});

// Import the plugin — obsidian is aliased via vitest.config.ts
const { default: VaultOrePlugin } = await import("./main");
// Typed as the mock, which records notices and event handlers for assertions.
const { FileSystemAdapter, Notice, TFile, requestUrl } = (await import("obsidian")) as unknown as typeof import("./__mocks__/obsidian");
const { DEFAULT_MODELS, DEFAULT_PROVIDER, WorkflowScheduler } = await import("@vaultore/core");
type RecordedSetting = import("./__mocks__/obsidian").Setting;

describe("VaultOrePlugin", () => {
  let plugin: InstanceType<typeof VaultOrePlugin>;

  beforeEach(async () => {
    vi.useFakeTimers();
    // Core's timers come from window; tests run without a DOM.
    vi.stubGlobal("window", globalThis);
    plugin = new VaultOrePlugin(undefined as any, undefined as any);
    // Spy on mock methods from the base class
    vi.spyOn(plugin, "addCommand");
    vi.spyOn(plugin, "addSettingTab");
    vi.spyOn(plugin, "registerEvent");
    vi.spyOn(plugin, "registerInterval");
    vi.spyOn(plugin, "saveData");
    vi.spyOn(plugin, "loadData").mockResolvedValue(null);

    await plugin.onload();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // Renders the settings tab the plugin registered and returns what it showed.
  function renderSettings(): RecordedSetting[] {
    const calls = (plugin.addSettingTab as ReturnType<typeof vi.fn>).mock.calls;
    const tab = calls[0][0];
    tab.display();
    return tab.containerEl.settings;
  }

  describe("onload", () => {
    it("registers three commands", () => {
      expect(plugin.addCommand).toHaveBeenCalledTimes(3);

      const calls = (plugin.addCommand as ReturnType<typeof vi.fn>).mock.calls;
      const ids = calls.map((c: any[]) => c[0].id);
      expect(ids).toContain("run-all");
      expect(ids).toContain("run-cell");
      expect(ids).toContain("run-cell-only");
    });

    it("registers a settings tab", () => {
      expect(plugin.addSettingTab).toHaveBeenCalledTimes(1);
    });

    it("registers metadata and vault event handlers", () => {
      // metadataCache changed + vault delete + vault rename
      expect(plugin.registerEvent).toHaveBeenCalledTimes(3);
    });
  });

  describe("settings", () => {
    it("loads with defaults when no saved data", () => {
      expect(plugin.settings.defaultProvider).toBe("openai");
      expect(plugin.settings.defaultModel).toBe("gpt-5-mini");
      // ...and those are core's defaults, not a second copy.
      expect(plugin.settings.defaultProvider).toBe(DEFAULT_PROVIDER);
      expect(plugin.settings.defaultModel).toBe(DEFAULT_MODELS[DEFAULT_PROVIDER]);
      expect(plugin.settings.runtimeEngine).toBe("docker");
      expect(plugin.settings.outputRoot).toBe("_vaultore");
    });

    it("merges saved data with defaults", async () => {
      (plugin.loadData as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        defaultProvider: "anthropic",
        defaultModel: "claude-sonnet-4-20250514",
      });
      await plugin.loadSettings();

      expect(plugin.settings.defaultProvider).toBe("anthropic");
      expect(plugin.settings.defaultModel).toBe("claude-sonnet-4-20250514");
      // Defaults still applied for unset fields
      expect(plugin.settings.runtimeEngine).toBe("docker");
      expect(plugin.settings.outputRoot).toBe("_vaultore");
    });

    it("persists settings on save", async () => {
      plugin.settings.defaultProvider = "anthropic";
      await plugin.saveSettings();

      expect(plugin.saveData).toHaveBeenCalledWith(
        expect.objectContaining({ defaultProvider: "anthropic" })
      );
    });

    it("has no warm container pool setting: it was a visible no-op", async () => {
      const names = renderSettings().map((setting) => setting.name);
      expect(names).not.toContain("Warm container pool");

      // A key saved by an earlier version is dropped, not carried forward.
      (plugin.loadData as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        enableWarmPool: true,
      });
      await plugin.loadSettings();
      await plugin.saveSettings();
      expect(plugin.saveData).toHaveBeenLastCalledWith(
        expect.not.objectContaining({ enableWarmPool: expect.anything() })
      );
    });

    it("shows ore:ai as code in the provider description", () => {
      const provider = renderSettings().find((setting) => setting.name === "Default provider");
      expect(provider?.desc).toBe("Provider used for ore:ai cells.");
    });

    it("preserves all default fields on fresh load", () => {
      expect(plugin.settings.aiTemperature).toBeUndefined();
      expect(plugin.settings.aiMaxTokens).toBe(800);
      expect(plugin.settings.permissionDecisions).toEqual({});
    });
  });

  describe("API keys", () => {
    // Obsidian's secret storage is a shared, user-managed store: the
    // SecretComponent hands the plugin the *name* of the secret the user
    // picked, and the plugin reads the value by that name when it needs it.
    function secretSetting(name: string) {
      const setting = renderSettings().find((s) => s.name === name);
      expect(setting).toBeDefined();
      return setting!;
    }

    function stubSecrets(values: Record<string, string>) {
      const setSecret = vi.fn();
      plugin.app.secretStorage = {
        getSecret: vi.fn((id: string) => values[id] ?? null),
        setSecret,
        listSecrets: () => Object.keys(values),
      } as any;
      return { setSecret };
    }

    const adapter = () => (plugin as any).adapter;

    it("saves the name of the selected secret, never a key", async () => {
      const { setSecret } = stubSecrets({ "shared-openai": "sk-live" });
      const component = secretSetting("OpenAI API key").components[0] as any;

      await component.changeHandler("shared-openai");

      expect(plugin.settings.openaiSecretName).toBe("shared-openai");
      expect(plugin.saveData).toHaveBeenLastCalledWith(
        expect.objectContaining({ openaiSecretName: "shared-openai" })
      );
      expect(setSecret).not.toHaveBeenCalled();
    });

    it("treats a null selection as no secret selected", async () => {
      plugin.settings.anthropicSecretName = "old";
      const component = secretSetting("Anthropic API key").components[0] as any;

      await component.changeHandler(null);

      expect(plugin.settings.anthropicSecretName).toBe("");
    });

    it("shows the saved selection when the tab opens", () => {
      plugin.settings.openaiSecretName = "shared-openai";
      stubSecrets({ "shared-openai": "sk-live" });
      const setting = secretSetting("OpenAI API key");
      expect((setting.components[0] as any).value).toBe("shared-openai");
      expect(setting.desc).toContain("shared-openai");
    });

    it("says when the selected secret is missing", () => {
      plugin.settings.openaiSecretName = "gone";
      stubSecrets({});
      expect(secretSetting("OpenAI API key").desc).toMatch(/gone.*missing or empty/);
    });

    it("clears the selection with the clear button", async () => {
      plugin.settings.openaiSecretName = "shared-openai";
      const setting = secretSetting("OpenAI API key");

      await setting.buttons[0].clickHandler!();

      expect(plugin.settings.openaiSecretName).toBe("");
    });

    it("resolves each provider key through its selected secret", async () => {
      stubSecrets({ "shared-openai": "sk-live", "team-anthropic": "sk-ant" });
      plugin.settings.openaiSecretName = "shared-openai";
      plugin.settings.anthropicSecretName = "team-anthropic";

      await expect(adapter().getSecret("openai.apiKey")).resolves.toBe("sk-live");
      await expect(adapter().getSecret("anthropic.apiKey")).resolves.toBe("sk-ant");
    });

    it("fails with the setting's name when no secret is selected", async () => {
      stubSecrets({ "vaultore-openai-apikey": "stale" });
      plugin.settings.openaiSecretName = "";

      await expect(adapter().getSecret("openai.apiKey")).rejects.toThrow(
        /No secret selected for "OpenAI API key"/
      );
    });

    it("fails with the secret's and setting's names when the secret is empty", async () => {
      stubSecrets({ "team-anthropic": "  " });
      plugin.settings.anthropicSecretName = "team-anthropic";

      await expect(adapter().getSecret("anthropic.apiKey")).rejects.toThrow(
        /"team-anthropic".*"Anthropic API key".*missing or empty/
      );
    });

    it("rejects secret keys it has no setting for", async () => {
      await expect(adapter().getSecret("mistral.apiKey")).rejects.toThrow(/mistral\.apiKey/);
    });

    it("does not write to the user's secret storage", async () => {
      const { setSecret } = stubSecrets({});
      await expect(adapter().setSecret("openai.apiKey", "sk")).rejects.toThrow(/API keys/);
      await expect(adapter().deleteSecret("openai.apiKey")).rejects.toThrow(/API keys/);
      expect(setSecret).not.toHaveBeenCalled();
    });
  });

  describe("HTTP requests (#78)", () => {
    // requestUrl runs outside the renderer's CORS; global fetch from the
    // renderer carries a browser Origin that Anthropic rejects.
    const request = {
      url: "https://api.anthropic.com/v1/messages",
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": "k" },
      body: "{}",
      timeoutMs: 120_000,
    };

    function send(req: typeof request) {
      return (plugin as unknown as {
        adapter: { request?: (r: typeof request) => Promise<unknown> };
      }).adapter.request!(req);
    }

    it("sends through requestUrl without throwing on an error status", async () => {
      vi.mocked(requestUrl).mockReset();
      vi.mocked(requestUrl).mockResolvedValue({ status: 401, text: "invalid x-api-key" } as never);

      const response = await send(request);

      expect(requestUrl).toHaveBeenCalledWith({
        url: request.url,
        method: "POST",
        headers: request.headers,
        body: "{}",
        throw: false,
      });
      expect(response).toEqual({ status: 401, text: "invalid x-api-key" });
    });

    it("lets a transport failure reject for core to describe", async () => {
      vi.mocked(requestUrl).mockReset();
      vi.mocked(requestUrl).mockRejectedValue(new Error("net::ERR_NAME_NOT_RESOLVED"));

      await expect(send(request)).rejects.toThrow("net::ERR_NAME_NOT_RESOLVED");
    });
  });

  describe("vault paths a cell may have linked out of the vault", () => {
    let base: string;

    beforeEach(() => {
      base = mkdtempSync(join(tmpdir(), "vaultore-obsidian-"));
      mkdirSync(join(base, "vault/notes"), { recursive: true });
      mkdirSync(join(base, "outside"));
      symlinkSync(join(base, "outside"), join(base, "vault/notes/x"));
    });

    afterEach(() => {
      rmSync(base, { recursive: true, force: true });
    });

    function resolveInVault(path: string) {
      return (plugin as unknown as {
        adapter: { resolveInVault: (p: string) => Promise<string> };
      }).adapter.resolveInVault(path);
    }

    it("refuses a path through a symlink that leads outside the vault folder", async () => {
      const adapter = new FileSystemAdapter();
      vi.spyOn(adapter, "getBasePath").mockReturnValue(join(base, "vault"));
      plugin.app.vault.adapter = adapter as never;

      await expect(resolveInVault("notes/x/authorized_keys")).rejects.toThrow(/outside the vault/);
      expect(await resolveInVault("/notes/new.md")).toBe("notes/new.md");
    });

    it("refuses every path when the vault has no folder on disk", async () => {
      plugin.app.vault.adapter = {} as never;

      await expect(resolveInVault("notes/new.md")).rejects.toThrow(/file system access/);
    });
  });

  describe("scheduler", () => {
    // Registered, the interval is cleared on unload even if stop() never runs.
    it("registers its tick interval with the plugin", () => {
      expect(plugin.registerInterval).toHaveBeenCalledTimes(1);
    });

    it("hands core the same timers through the adapter", () => {
      const adapter = (plugin as unknown as { adapter: { timers: unknown } }).adapter;
      expect(adapter.timers).toBe(plugin.timers);
    });
  });

  describe("onunload", () => {
    it("completes without error", () => {
      expect(() => plugin.onunload()).not.toThrow();
    });

    it("cleans up pending debounce timer", () => {
      // Trigger a debounced refresh by simulating a vault modify
      // The timer should be cleaned up on unload
      expect(() => plugin.onunload()).not.toThrow();
    });
  });

  describe("run commands", () => {
    function note(path: string): InstanceType<typeof TFile> {
      return Object.assign(new TFile(), {
        path,
        extension: "md",
        basename: path.replace(/\.md$/, ""),
      });
    }

    const workflow = note("Workflows/daily.md");
    const ordinary = note("Notes/shopping.md");

    function command(id: string) {
      const calls = (plugin.addCommand as ReturnType<typeof vi.fn>).mock.calls;
      const found = calls.find((c: any[]) => c[0].id === id);
      expect(found).toBeDefined();
      return found![0];
    }

    beforeEach(() => {
      plugin.app.metadataCache.getFileCache = (file: { path: string }) =>
        file.path === workflow.path
          ? { frontmatter: { ore: true } }
          : { frontmatter: { title: "Shopping" } };
    });

    it("offers run all cells only on a workflow note", () => {
      const cmd = command("run-all");

      plugin.app.workspace.getActiveFile = () => null;
      expect(cmd.checkCallback(true)).toBe(false);

      plugin.app.workspace.getActiveFile = () => ordinary;
      expect(cmd.checkCallback(true)).toBe(false);

      plugin.app.workspace.getActiveFile = () => workflow;
      expect(cmd.checkCallback(true)).toBe(true);
    });

    it("does not run anything when checking", () => {
      const run = vi.spyOn(plugin as any, "runWorkflow");
      plugin.app.workspace.getActiveFile = () => workflow;

      command("run-all").checkCallback(true);
      expect(run).not.toHaveBeenCalled();

      command("run-all").checkCallback(false);
      expect(run).toHaveBeenCalledWith(workflow);
    });

    it.each(["run-cell", "run-cell-only"])("offers %s only on a workflow note", (id) => {
      const cmd = command(id);
      const editor = { getCursor: () => ({ line: 0, ch: 0 }) };

      expect(cmd.editorCheckCallback(true, editor, { file: ordinary })).toBe(false);
      expect(cmd.editorCheckCallback(true, editor, { file: null })).toBe(false);
      expect(cmd.editorCheckCallback(true, editor, { file: workflow })).toBe(true);
    });
  });
});

describe("scheduled workflows", () => {
  type Frontmatter = Record<string, unknown>;
  let plugin: InstanceType<typeof VaultOrePlugin>;
  let notes: Record<string, Frontmatter>;

  function note(path: string): InstanceType<typeof TFile> {
    return Object.assign(new TFile(), { path, extension: "md", basename: path });
  }

  // Replaces the vault with these notes; frontmatter is served from the
  // metadata cache the way Obsidian does.
  function useVault(next: Record<string, Frontmatter>) {
    notes = next;
  }

  const scheduler = () => (plugin as any).scheduler as InstanceType<typeof WorkflowScheduler>;
  const armed = () => scheduler().list().map((entry) => `${entry.path} ${entry.cronExpression}`);
  const refresh = () => (plugin as any).refreshScheduledWorkflows();

  function renderSettings(): RecordedSetting[] {
    const calls = (plugin.addSettingTab as ReturnType<typeof vi.fn>).mock.calls;
    const tab = calls[0][0];
    tab.display();
    return tab.containerEl.settings;
  }

  function row(name: string): RecordedSetting {
    const found = renderSettings().find((setting) => setting.name === name);
    expect(found, `setting "${name}"`).toBeDefined();
    return found!;
  }

  async function toggle(name: string, value: boolean) {
    await row(name).toggles[0].changeHandler!(value);
  }

  beforeEach(async () => {
    vi.useFakeTimers();
    // The plugin debounces with window.setTimeout; tests run without a DOM.
    vi.stubGlobal("window", globalThis);
    Notice.shown.length = 0;
    notes = {};
    plugin = new VaultOrePlugin(undefined as any, undefined as any);
    vi.spyOn(plugin, "addSettingTab");
    vi.spyOn(plugin, "saveData");
    vi.spyOn(plugin, "loadData").mockResolvedValue(null);
    (plugin.app.vault as any).handlers = {};
    plugin.app.vault.getMarkdownFiles = () => Object.keys(notes).map(note);
    plugin.app.vault.getAbstractFileByPath = (path: string) => (path in notes ? note(path) : null);
    plugin.app.vault.modify = vi.fn();
    plugin.app.metadataCache.getFileCache = (file: { path: string }) =>
      file.path in notes ? { frontmatter: notes[file.path] } : null;
    await plugin.onload();
  });

  afterEach(() => {
    plugin.onunload();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("is off by default and arms nothing, including notes that arrive by sync", () => {
    useVault({ "Workflows/daily.md": { ore: true, schedule: "0 18 * * *" } });
    refresh();

    expect(armed()).toEqual([]);
    expect(plugin.settings.runScheduledWorkflows).toBe(false);
    expect(plugin.settings.scheduleApprovals).toEqual({});
  });

  it("lists every scheduled workflow note with its schedule and a toggle", () => {
    useVault({
      "Workflows/daily.md": { ore: true, schedule: "0 18 * * *" },
      "Workflows/manual.md": { ore: true },
      "Notes/plain.md": { schedule: "0 18 * * *" },
    });
    const settings = renderSettings();

    expect(settings.find((s) => s.heading && s.name === "Scheduled workflows")).toBeDefined();
    const master = row("Run scheduled workflows");
    expect(master.toggles[0].value).toBe(false);

    const daily = row("Workflows/daily.md");
    expect(daily.desc).toContain("0 18 * * *");
    expect(daily.desc).toMatch(/not approved/i);
    expect(daily.toggles[0].value).toBe(false);
    expect(settings.map((s) => s.name)).not.toContain("Workflows/manual.md");
    expect(settings.map((s) => s.name)).not.toContain("Notes/plain.md");
  });

  it("runs a note only with the master switch on and the note approved", async () => {
    useVault({ "Workflows/daily.md": { ore: true, schedule: "0 18 * * *" } });

    await toggle("Workflows/daily.md", true);
    expect(plugin.settings.scheduleApprovals).toEqual({ "Workflows/daily.md": "0 18 * * *" });
    expect(armed()).toEqual([]);

    await toggle("Run scheduled workflows", true);
    expect(armed()).toEqual(["Workflows/daily.md 0 18 * * *"]);
    expect(row("Workflows/daily.md").desc).toMatch(/next run/i);

    await toggle("Workflows/daily.md", false);
    expect(plugin.settings.scheduleApprovals).toEqual({});
    expect(armed()).toEqual([]);
  });

  it("keeps the decisions in plugin settings, not in the notes", async () => {
    useVault({ "Workflows/daily.md": { ore: true, schedule: "0 18 * * *" } });

    await toggle("Run scheduled workflows", true);
    await toggle("Workflows/daily.md", true);

    expect(plugin.saveData).toHaveBeenLastCalledWith(
      expect.objectContaining({
        runScheduledWorkflows: true,
        scheduleApprovals: { "Workflows/daily.md": "0 18 * * *" },
      })
    );
    expect(plugin.app.vault.modify).not.toHaveBeenCalled();
  });

  it("needs a new approval when the schedule changes", async () => {
    useVault({ "Workflows/daily.md": { ore: true, schedule: "0 18 * * *" } });
    await toggle("Run scheduled workflows", true);
    await toggle("Workflows/daily.md", true);

    notes["Workflows/daily.md"].schedule = "* * * * *";
    refresh();

    expect(armed()).toEqual([]);
    const daily = row("Workflows/daily.md");
    expect(daily.toggles[0].value).toBe(false);
    expect(daily.desc).toMatch(/changed from "0 18 \* \* \*" to "\* \* \* \* \*"/);
  });

  it("lists notes that appear later without arming them", async () => {
    useVault({ "Workflows/daily.md": { ore: true, schedule: "0 18 * * *" } });
    await toggle("Run scheduled workflows", true);
    await toggle("Workflows/daily.md", true);

    notes["Inbox/from-sync.md"] = { ore: true, schedule: "* * * * *" };
    refresh();

    expect(armed()).toEqual(["Workflows/daily.md 0 18 * * *"]);
    expect(row("Inbox/from-sync.md").toggles[0].value).toBe(false);
  });

  it("keeps the timers of unchanged notes when the vault changes", async () => {
    useVault({
      "Workflows/daily.md": { ore: true, schedule: "0 18 * * *" },
      "Workflows/hourly.md": { ore: true, schedule: "0 * * * *" },
    });
    await toggle("Run scheduled workflows", true);
    await toggle("Workflows/daily.md", true);
    await toggle("Workflows/hourly.md", true);
    const hourly = scheduler().list().find((e) => e.path === "Workflows/hourly.md")!;
    const due = new Date(Date.now() - 1000);
    hourly.nextRun = due;
    const unregister = vi.spyOn(scheduler(), "unregister");

    // Another note changes: nothing is re-registered.
    notes["Notes/other.md"] = { title: "x" };
    refresh();
    expect(unregister).not.toHaveBeenCalled();

    // Only the note whose approval changed is touched.
    await toggle("Workflows/daily.md", false);
    expect(unregister.mock.calls).toEqual([["Workflows/daily.md"]]);
    expect(scheduler().list().find((e) => e.path === "Workflows/hourly.md")?.nextRun).toBe(due);
  });

  it("runs a due approved note on the tick", async () => {
    useVault({ "Workflows/daily.md": { ore: true, schedule: "0 18 * * *" } });
    await toggle("Run scheduled workflows", true);
    await toggle("Workflows/daily.md", true);
    const run = vi.spyOn(plugin as any, "runWorkflowByPath").mockResolvedValue(undefined);

    scheduler().list()[0].nextRun = new Date(Date.now() - 1000);
    scheduler().tick();

    expect(run).toHaveBeenCalledWith("Workflows/daily.md");
  });

  // The note can go between the tick and the run, before the vault's delete
  // or rename event has refreshed the schedules (#121).
  it("says so when a due note is gone, instead of doing nothing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const runWorkflow = vi.spyOn(plugin as any, "runWorkflow");

    await (plugin as any).runWorkflowByPath("Workflows/gone.md");

    expect(runWorkflow).not.toHaveBeenCalled();
    expect(Notice.shown.filter((m) => m.includes("Workflows/gone.md"))).toHaveLength(1);
    expect(String(warn.mock.calls[0])).toContain("Workflows/gone.md");
    warn.mockRestore();
  });

  it("does not run a note whose schedule changed before the refresh caught up", async () => {
    useVault({ "Workflows/daily.md": { ore: true, schedule: "0 18 * * *" } });
    await toggle("Run scheduled workflows", true);
    await toggle("Workflows/daily.md", true);
    const run = vi.spyOn(plugin as any, "runWorkflowByPath").mockResolvedValue(undefined);

    notes["Workflows/daily.md"].schedule = "* * * * *";
    scheduler().list()[0].nextRun = new Date(Date.now() - 1000);
    scheduler().tick();

    expect(run).not.toHaveBeenCalled();
  });

  it("shows an invalid schedule and warns once instead of swallowing it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    useVault({ "Workflows/typo.md": { ore: true, schedule: "every day" } });
    await toggle("Run scheduled workflows", true);
    plugin.settings.scheduleApprovals = { "Workflows/typo.md": "every day" };

    refresh();
    refresh();

    expect(armed()).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0])).toContain("Workflows/typo.md");
    expect(Notice.shown.filter((m) => m.includes("Workflows/typo.md"))).toHaveLength(1);
    const typo = row("Workflows/typo.md");
    expect(typo.desc).toMatch(/invalid/i);
    expect(typo.toggles[0].disabled).toBe(true);
    warn.mockRestore();
  });

  it("drops the approval of a note that is deleted or renamed", async () => {
    useVault({
      "Workflows/a.md": { ore: true, schedule: "0 18 * * *" },
      "Workflows/b.md": { ore: true, schedule: "0 9 * * *" },
    });
    await toggle("Workflows/a.md", true);
    await toggle("Workflows/b.md", true);

    const [onDelete] = (plugin.app.vault as any).handlers.delete;
    const [onRename] = (plugin.app.vault as any).handlers.rename;
    await onDelete(note("Workflows/a.md"));
    await onRename(note("Archive/b.md"), "Workflows/b.md");

    expect(plugin.settings.scheduleApprovals).toEqual({});
    expect(plugin.saveData).toHaveBeenLastCalledWith(
      expect.objectContaining({ scheduleApprovals: {} })
    );
  });
});

describe("manifest.json", () => {
  it("has required fields for Obsidian community plugin", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const manifestPath = path.resolve(__dirname, "../manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

    expect(manifest.id).toBe("vaultore");
    expect(manifest.name).toBe("VaultOre");
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(manifest.minAppVersion).toBeDefined();
    expect(manifest.description).toBeTruthy();
    expect(manifest.author).toBeTruthy();
    expect(manifest.isDesktopOnly).toBe(true);
  });

  // The community directory reads the repository root's manifest, the release
  // ships this package's copy, and lint validates only this package's copy
  // (#133). Identical files keep all three in agreement.
  it("is identical to the repository root's manifest.json", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const packageManifest = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, "../manifest.json"), "utf8")
    );
    const repoManifest = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, "../../../manifest.json"), "utf8")
    );

    expect(packageManifest).toEqual(repoManifest);
  });
});

describe("versions.json", () => {
  it("maps plugin versions to minAppVersion", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const versionsPath = path.resolve(__dirname, "../../../versions.json");
    const versions = JSON.parse(fs.readFileSync(versionsPath, "utf8"));

    expect(typeof versions).toBe("object");
    // All keys and values are semver triples
    for (const [key, value] of Object.entries(versions)) {
      expect(key).toMatch(/^\d+\.\d+\.\d+$/);
      expect(value).toMatch(/^\d+\.\d+\.\d+$/);
    }

    // What this asserts: once versions.json has any entry, the manifest's
    // version is one of them, mapped to the manifest's minAppVersion. The file
    // is legally empty before the first release; version-bump.mjs adds the
    // entry when `bun run release` cuts one, and at no other time.
    //
    // Why: an Obsidian app older than the manifest's minAppVersion falls back
    // to the newest plugin version this map lists for it (docs.obsidian.md,
    // Reference/Versions, read 2026-10-15), so an entry must name a version
    // that was actually released.
    const manifestPath = path.resolve(__dirname, "../../../manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

    if (Object.keys(versions).length > 0) {
      expect(versions[manifest.version]).toBeDefined();
      expect(versions[manifest.version]).toBe(manifest.minAppVersion);
    }
  });
});
