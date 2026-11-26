import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---- Core module mock (before importing main) ----
// The scheduler, cron parsing, the workflow check and the model defaults are
// the real ones, so the plugin's scheduling and command guards are tested
// against core's behaviour and the plugin cannot carry its own copy of the
// defaults (#78). Only the executor (containers, AI) and the cell parser are
// faked.
// The run lock is the real one, in a directory of the test's own: a test never
// touches the user's ~/.config/vaultore/locks.
const runLocks = vi.hoisted(() => ({ directory: "", slots: "" }));
// This machine's shared settings likewise: a file of the test's own, never
// ~/.config/vaultore/settings.json; removed before each test.
const machineSettings = vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "vaultore-plugin-settings-"));
  return { path: join(dir, "settings.json"), schedules: join(dir, "obsidian-schedules.json") };
});
vi.mock("@vaultore/core", async () => {
  const actual = await vi.importActual<typeof import("@vaultore/core")>("@vaultore/core");
  return {
    DEFAULT_MODELS: actual.DEFAULT_MODELS,
    DEFAULT_PROVIDER: actual.DEFAULT_PROVIDER,
    RunLockHeldError: actual.RunLockHeldError,
    acquireRunLock: (options: import("@vaultore/core").RunLockOptions) =>
      actual.acquireRunLock({ ...options, directory: runLocks.directory }),
    describeHolder: actual.describeHolder,
    MAX_KEEP_DAYS: actual.MAX_KEEP_DAYS,
    SlotTakenError: actual.SlotTakenError,
    // The schedule record is the real one too, in the test's own directory.
    claimSlot: (options: import("@vaultore/core").ClaimSlotOptions) =>
      actual.claimSlot({ ...options, directory: runLocks.slots, pruneIntervalMs: 0 }),
    MissedSlotError: actual.MissedSlotError,
    isLateSlot: actual.isLateSlot,
    lateAfterMs: actual.lateAfterMs,
    readMachineSettings: () => actual.readMachineSettings({ path: machineSettings.path }),
    // The scheduling consent, likewise in the test's own file (#276); the
    // vault key is the root as given, as the test vaults need not exist.
    pluginSchedulesStore: () => actual.pluginSchedulesStore({ path: machineSettings.schedules }),
    vaultKeyFor: async (root: string) => root,
    writeMachineSettings: (changes: import("@vaultore/core").MachineSettings) =>
      actual.writeMachineSettings(changes, { path: machineSettings.path }),
    recordMissedSlots: (options: import("@vaultore/core").RecordMissedOptions) =>
      actual.recordMissedSlots({ ...options, directory: runLocks.slots }),
    readSlotRecord: (options: import("@vaultore/core").ReadSlotRecordOptions) =>
      actual.readSlotRecord({ ...options, directory: runLocks.slots }),
    catchUpMissedSlot: (options: import("@vaultore/core").ResolveMissedOptions) =>
      actual.catchUpMissedSlot({ ...options, directory: runLocks.slots }),
    dismissMissedSlots: (options: import("@vaultore/core").ResolveMissedOptions) =>
      actual.dismissMissedSlots({ ...options, directory: runLocks.slots }),
    WorkflowExecutor: class {
      // A run with no cells, as the executor returns one.
      runWorkflow = vi.fn().mockResolvedValue({ cells: [], outputs: new Map() });
    },
    WorkflowParser: class {
      parse = vi.fn().mockReturnValue({
        frontmatter: {},
        cells: [],
      });
    },
    WorkflowScheduler: actual.WorkflowScheduler,
    computeNextRun: actual.computeNextRun,
    describeRun: actual.describeRun,
    summarizeRun: actual.summarizeRun,
    errorMessage: actual.errorMessage,
    isWorkflowFrontmatter: actual.isWorkflowFrontmatter,
    resolveInVaultRoot: actual.resolveInVaultRoot,
  };
});

// Import the plugin — obsidian is aliased via vitest.config.mts
const { default: VaultOrePlugin } = await import("./main");
// Typed as the mock, which records notices and event handlers for assertions.
const { FileSystemAdapter, Notice, TFile, requestUrl } = (await import("obsidian")) as unknown as typeof import("./__mocks__/obsidian");
const { DEFAULT_MODELS, DEFAULT_PROVIDER, RunLockHeldError, WorkflowScheduler } = await import("@vaultore/core");
type RecordedSetting = import("./__mocks__/obsidian").Setting;

describe("VaultOrePlugin", () => {
  let plugin: InstanceType<typeof VaultOrePlugin>;

  beforeEach(async () => {
    rmSync(machineSettings.path, { force: true });
    rmSync(machineSettings.schedules, { force: true });
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
    const tab = at(at(calls));
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

  // Obsidian 1.13 indexes a tab's settings for its settings search only when
  // the tab declares them (#137).
  describe("declarative settings", () => {
    const settingsTab = () =>
      at(at((plugin.addSettingTab as ReturnType<typeof vi.fn>).mock.calls));
    const row = (name: string) => {
      const found = renderSettings().find((setting) => setting.name === name);
      expect(found, `setting "${name}"`).toBeDefined();
      return found!;
    };

    it("declares every setting instead of drawing the tab itself", () => {
      const prototype = Object.getPrototypeOf(settingsTab());
      expect(Object.getOwnPropertyNames(prototype)).toContain("getSettingDefinitions");
      expect(Object.getOwnPropertyNames(prototype)).not.toContain("display");
      expect(settingsTab().getSettingDefinitions().length).toBeGreaterThan(0);
    });

    it("puts each setting under its heading and lets search find it", () => {
      const settings = renderSettings();
      expect(settings.filter((s) => s.heading).map((s) => s.name)).toEqual([
        "AI",
        "Execution",
        "API keys",
        "Scheduled workflows",
      ]);
      for (const name of [
        "Default provider",
        "Default model",
        "Temperature",
        "Max tokens",
        "AI request timeout",
        "Default runtime engine",
        "Output folder",
        "OpenAI API key",
        "Anthropic API key",
        "Run scheduled workflows",
      ]) {
        expect(row(name).searchable, name).toBe(true);
      }
    });

    it("shows a blank numeric field as the provider default, with its placeholder", () => {
      expect(at(row("Temperature").texts).value).toBe("");
      expect(at(row("Max tokens").texts).value).toBe("800");
      expect(at(row("AI request timeout").texts).placeholder).toBe("120");
    });

    it("stores a valid number, and blank as unset", async () => {
      await at(row("Temperature").texts).changeHandler!("0.7");
      expect(plugin.settings.aiTemperature).toBe(0.7);

      await at(row("Temperature").texts).changeHandler!(" ");
      expect(plugin.settings.aiTemperature).toBeUndefined();
      expect(plugin.saveData).toHaveBeenCalled();
    });

    // How late a scheduled run may start (#269): 2 to 60 minutes, blank 2.
    // This machine's, in the file vaultore agent reads, not in data.json.
    it("stores Late after from 2 to 60 minutes in the machine's file, and the scheduler uses it", async () => {
      const lateRow = row("Late after");
      const late = at(lateRow.texts);
      const scheduler = (plugin as any).scheduler as InstanceType<typeof WorkflowScheduler>;
      expect(scheduler.lateAfterMs).toBe(2 * 60_000);

      await late.changeHandler!("15");
      expect(JSON.parse(readFileSync(machineSettings.path, "utf8"))).toEqual({ lateAfterMinutes: 15 });
      expect(scheduler.lateAfterMs).toBe(15 * 60_000);
      expect((plugin.settings as unknown as Record<string, unknown>)["lateAfterMinutes"]).toBeUndefined();

      await late.changeHandler!("1");
      expect(lateRow.error).toMatch(/from 2 to 60/);
      await late.changeHandler!("61");
      expect(JSON.parse(readFileSync(machineSettings.path, "utf8"))).toEqual({ lateAfterMinutes: 15 });

      await late.changeHandler!("");
      expect(JSON.parse(readFileSync(machineSettings.path, "utf8"))).toEqual({});
      expect(scheduler.lateAfterMs).toBe(2 * 60_000);
    });

    // vaultore schedules late-after changed it: Obsidian follows within a minute.
    it("follows a change of the machine's file, and keeps the last good value when it turns unusable", async () => {
      const scheduler = (plugin as any).scheduler as InstanceType<typeof WorkflowScheduler>;
      writeFileSync(machineSettings.path, JSON.stringify({ lateAfterMinutes: 30 }));
      await plugin.loadMachineSettings();
      expect(scheduler.lateAfterMs).toBe(30 * 60_000);

      writeFileSync(machineSettings.path, "{broken");
      await plugin.loadMachineSettings();
      await plugin.loadMachineSettings();
      expect(scheduler.lateAfterMs).toBe(30 * 60_000);
      expect(Notice.shown.filter((m) => m.includes("is not valid JSON"))).toHaveLength(1);
    });

    // 0 switches the history off (each run kept for a day only), blank keeps
    // 30; the two must not collapse into one (#255).
    it("stores a history of 0 days as 0, and refuses more than 30 or a fraction", async () => {
      const history = at(row("Scheduled-run history").texts);
      expect(history.placeholder).toBe("30");

      await history.changeHandler!("0");
      expect(plugin.settings.scheduleHistoryDays).toBe(0);

      await history.changeHandler!("31");
      await history.changeHandler!("1.5");
      expect(plugin.settings.scheduleHistoryDays).toBe(0);

      await history.changeHandler!("");
      expect(plugin.settings.scheduleHistoryDays).toBeUndefined();
    });

    it("refuses a number out of range with a message and keeps the old value", async () => {
      const temperature = row("Temperature");
      await at(temperature.texts).changeHandler!("3");

      expect(temperature.error).toMatch(/0 to 2/);
      expect(plugin.settings.aiTemperature).toBeUndefined();

      const tokens = row("Max tokens");
      await at(tokens.texts).changeHandler!("lots");
      expect(tokens.error).toMatch(/above 0/);
      expect(plugin.settings.aiMaxTokens).toBe(800);
    });

    it("falls back to the provider's default model when the field is cleared", async () => {
      await at(row("Default model").texts).changeHandler!("  ");
      expect(plugin.settings.defaultModel).toBe(DEFAULT_MODELS[plugin.settings.defaultProvider]);
    });

    it("stores the output folder without leading or trailing slashes", async () => {
      await at(row("Output folder").texts).changeHandler!(" /runs/out/ ");
      expect(plugin.settings.outputRoot).toBe("runs/out");

      await at(row("Output folder").texts).changeHandler!("/");
      expect(plugin.settings.outputRoot).toBe("_vaultore");
    });

    it("stores the engine chosen in the dropdown", async () => {
      const engine = at(row("Default runtime engine").dropdowns);
      expect(engine.options).toEqual(["docker", "podman", "colima", "apple"]);

      await engine.changeHandler!("colima");
      expect(plugin.settings.runtimeEngine).toBe("colima");
    });

    // The old provider's default under the new provider fails every AI cell
    // with the provider/model mismatch error (#115, #78).
    it("switches the default model with the provider when it was the old default", async () => {
      expect(plugin.settings.defaultModel).toBe(DEFAULT_MODELS.openai);

      await at(row("Default provider").dropdowns).changeHandler!("anthropic");

      expect(plugin.settings.defaultProvider).toBe("anthropic");
      expect(plugin.settings.defaultModel).toBe(DEFAULT_MODELS.anthropic);
      expect(at(row("Default model").texts).value).toBe(DEFAULT_MODELS.anthropic);
      expect(plugin.saveData).toHaveBeenLastCalledWith(
        expect.objectContaining({ defaultModel: DEFAULT_MODELS.anthropic })
      );
    });

    it("keeps a model the user chose when the provider changes", async () => {
      await at(row("Default model").texts).changeHandler!("gpt-5");

      await at(row("Default provider").dropdowns).changeHandler!("anthropic");

      expect(plugin.settings.defaultModel).toBe("gpt-5");
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

      await at(setting.buttons).clickHandler!();

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

  // One run per note, shared with the CLI (#215).
  describe("the run lock", () => {
    let base: string;

    beforeEach(() => {
      base = mkdtempSync(join(tmpdir(), "vaultore-obsidian-lock-"));
      runLocks.directory = join(base, "locks");
      mkdirSync(join(base, "vault/notes"), { recursive: true });
      writeFileSync(join(base, "vault/notes/daily.md"), "---\nore: true\n---\n");
      const adapter = new FileSystemAdapter();
      vi.spyOn(adapter, "getBasePath").mockReturnValue(join(base, "vault"));
      plugin.app.vault.adapter = adapter as never;
    });

    afterEach(() => {
      rmSync(base, { recursive: true, force: true });
    });

    function acquireRunLock(path: string) {
      return (plugin as unknown as {
        adapter: { acquireRunLock: (p: string) => Promise<{ release: () => Promise<void> }> };
      }).adapter.acquireRunLock(path);
    }

    it("locks the note as Obsidian, and a second run of it is told so", async () => {
      const release = await acquireRunLock("notes/daily.md");

      const refusal: unknown = await acquireRunLock("notes/daily.md").catch((err: unknown) => err);

      expect(refusal).toBeInstanceOf(RunLockHeldError);
      expect(String(refusal)).toContain(`notes/daily.md is already being run by process ${process.pid} (Obsidian)`);
      await release.release();
      await (await acquireRunLock("notes/daily.md")).release();
    });

    // Not an error of this run: the notice names who has the note.
    it("shows a note another runner is running as such, not as an error", async () => {
      const file = Object.assign(new TFile(), { path: "notes/daily.md", basename: "daily" });
      plugin.app.vault.read = vi.fn().mockResolvedValue("---\nore: true\n---\n") as never;
      const executor = (plugin as unknown as { executor: { runWorkflow: ReturnType<typeof vi.fn> } }).executor;
      executor.runWorkflow.mockRejectedValueOnce(
        new RunLockHeldError("notes/daily.md", undefined, "notes/daily.md is already being run by process 7 (vaultore agent)")
      );
      Notice.shown.length = 0;

      await (plugin as unknown as { runWorkflow: (f: unknown) => Promise<void> }).runWorkflow(file);

      expect(Notice.shown).toContain("VaultOre: notes/daily.md is already being run by process 7 (vaultore agent)");
      expect(Notice.shown.some((message) => message.startsWith("VaultOre error"))).toBe(false);
    });

    // The notice says how the run went, not "completed" whatever its cells came to (#290).
    describe("the notice at the end of a run", () => {
      const output = (cellId: string, status: "success" | "error") => ({
        cellId,
        value: null,
        meta: { status, duration: 1, timestamp: "2026-11-26T00:00:00.000Z" },
      });
      const cells = [
        { attributes: { id: "fetch", type: "shell" } },
        { attributes: { id: "report", type: "shell", depends: ["fetch"] } },
        { attributes: { id: "other", type: "shell" } },
      ];

      async function runWith(statuses: Record<string, "success" | "error">): Promise<string[]> {
        const file = Object.assign(new TFile(), { path: "notes/daily.md", basename: "daily" });
        plugin.app.vault.read = vi.fn().mockResolvedValue("---\nore: true\n---\n") as never;
        const executor = (plugin as unknown as { executor: { runWorkflow: ReturnType<typeof vi.fn> } }).executor;
        executor.runWorkflow.mockImplementationOnce(
          async (options: { emitEvent?: (event: string, data: unknown) => void }) => {
            for (const cellId of Object.keys(statuses)) options.emitEvent?.("cell:started", { cellId });
            return {
              cells,
              outputs: new Map(Object.entries(statuses).map(([id, status]) => [id, output(id, status)])),
            };
          }
        );
        Notice.shown.length = 0;
        await (plugin as unknown as { runWorkflow: (f: unknown) => Promise<void> }).runWorkflow(file);
        return Notice.shown.filter((message) => !message.startsWith("VaultOre: Running"));
      }

      it("says completed when every cell succeeded", async () => {
        expect(await runWith({ fetch: "success", other: "success", report: "success" })).toEqual(["VaultOre: daily completed"]);
      });

      it("names a failed cell, and a cell that did not run because of it, apart", async () => {
        expect(await runWith({ fetch: "error", other: "success", report: "error" })).toEqual([
          "VaultOre: daily finished, 1 of 3 cells failed (fetch), 1 did not run because a cell it needs did not succeed (report)",
        ]);
      });
    });

    // One run per scheduled slot, shared with the CLI (#255).
    describe("the schedule record", () => {
      const scheduled = { schedule: "15 * * * *", slot: new Date("2026-11-24T10:15:00.000Z") };
      const adapter = () => (plugin as unknown as { adapter: import("@vaultore/core").PlatformAdapter }).adapter;

      beforeEach(() => {
        runLocks.slots = join(base, "slots");
      });

      it("claims a slot as Obsidian, and refuses a second claim of it", async () => {
        const { SlotTakenError, readSlotRecord } = await vi.importActual<typeof import("@vaultore/core")>("@vaultore/core");
        await adapter().claimSlot!("notes/daily.md", scheduled);

        await expect(adapter().claimSlot!("notes/daily.md", scheduled)).rejects.toBeInstanceOf(SlotTakenError);
        const [entry] = await readSlotRecord({ directory: runLocks.slots });
        expect(entry).toMatchObject({ note: "notes/daily.md", state: "running" });
        expect(entry?.claimedBy.by).toBe("Obsidian");
      });

      it("prunes by the history setting when it claims", async () => {
        const { readSlotRecord } = await vi.importActual<typeof import("@vaultore/core")>("@vaultore/core");
        const old = { ...scheduled, slot: new Date(Date.now() - 3 * 24 * 3_600_000) };
        await (await adapter().claimSlot!("notes/daily.md", old)).finish({ result: "completed" });
        plugin.settings.scheduleHistoryDays = 1;

        await adapter().claimSlot!("notes/daily.md", { ...scheduled, slot: new Date() });

        expect((await readSlotRecord({ directory: runLocks.slots })).some((e) => e.slot.getTime() === old.slot.getTime())).toBe(false);
      });

      it("hands the slot to the executor for a scheduled run", async () => {
        const file = Object.assign(new TFile(), { path: "notes/daily.md", basename: "daily" });
        plugin.app.vault.getAbstractFileByPath = vi.fn().mockReturnValue(file) as never;
        plugin.app.vault.read = vi.fn().mockResolvedValue("---\nore: true\n---\n") as never;
        const executor = (plugin as unknown as { executor: { runWorkflow: ReturnType<typeof vi.fn> } }).executor;
        executor.runWorkflow.mockClear();

        await (plugin as any).runWorkflowByPath("notes/daily.md", scheduled);

        expect(executor.runWorkflow).toHaveBeenCalledWith(expect.objectContaining({ workflowPath: "notes/daily.md", scheduled }));
      });

      // #269: runs no runner fired are recorded once, shown, and resolved.
      describe("missed runs", () => {
        const HOURLY = "15 * * * *";
        const lastRun = new Date(Date.now() - 6 * 3_600_000);

        beforeEach(async () => {
          // A run the note had, so there is a last decided slot to look after.
          await (await adapter().claimSlot!("notes/daily.md", { schedule: HOURLY, slot: lastRun })).finish({ result: "completed" });
          const file = Object.assign(new TFile(), { path: "notes/daily.md", basename: "daily" });
          plugin.app.vault.getAbstractFileByPath = vi.fn().mockReturnValue(file) as never;
          plugin.app.vault.read = vi.fn().mockResolvedValue("---\nore: true\n---\n") as never;
          Notice.shown.length = 0;
        });

        it("are recorded once, said once, and listed with Catch up and Dismiss", async () => {
          await plugin.lookForMissedRuns("notes/daily.md", HOURLY);
          await plugin.lookForMissedRuns("notes/daily.md", HOURLY);

          expect(Notice.shown.filter((m) => m.includes("missed"))).toHaveLength(1);
          expect(Notice.shown[0]).toMatch(/^VaultOre: notes\/daily\.md missed \d+ scheduled run\(s\) since /);
          expect(plugin.missedRuns).toHaveLength(1);
          const row = renderSettings().find((s) => s.name === "notes/daily.md" && s.buttons.length === 2);
          expect(row?.buttons.map((b) => b.text)).toEqual(["Catch up", "Dismiss"]);
        });

        // Found in the app: Obsidian keeps a settings tab as it last drew it,
        // also across reopening, so a change of the list redraws it.
        // Found in the app: a gap dismissed with the CLI stayed listed.
        it("are re-read each minute while listed, so one resolved elsewhere leaves the list", async () => {
          const { dismissMissedSlots } = await vi.importActual<typeof import("@vaultore/core")>("@vaultore/core");
          await plugin.lookForMissedRuns("notes/daily.md", HOURLY);
          expect(plugin.missedRuns).toHaveLength(1);
          await dismissMissedSlots({ vaultRoot: join(base, "vault"), notePath: "notes/daily.md", by: "vaultore", directory: runLocks.slots });

          await plugin.recheckMissedRuns();
          expect(plugin.missedRuns).toHaveLength(0);
        });

        it("redraw the settings tab when the list changes, and only then", async () => {
          const tab = (plugin as unknown as { settingsTab: { update: () => void } }).settingsTab;
          const update = vi.spyOn(tab, "update");

          await plugin.lookForMissedRuns("notes/daily.md", HOURLY);
          expect(update).toHaveBeenCalledTimes(1);

          await plugin.refreshMissedRuns();
          expect(update).toHaveBeenCalledTimes(1);
        });

        it("are dismissed from the settings, and leave the list", async () => {
          await plugin.lookForMissedRuns("notes/daily.md", HOURLY);
          const row = renderSettings().find((s) => s.name === "notes/daily.md" && s.buttons.length === 2);

          await row!.buttons[1]!.clickHandler!();

          expect(plugin.missedRuns).toEqual([]);
          const { readSlotRecord } = await vi.importActual<typeof import("@vaultore/core")>("@vaultore/core");
          expect((await readSlotRecord({ directory: runLocks.slots })).find((e) => e.kind === "missed")?.state).toBe("dismissed");
        });

        it("are caught up with one run that holds the gap", async () => {
          await plugin.lookForMissedRuns("notes/daily.md", HOURLY);
          const executor = (plugin as unknown as { executor: { runWorkflow: ReturnType<typeof vi.fn> } }).executor;
          executor.runWorkflow.mockClear();

          await plugin.catchUpMissedRun(plugin.missedRuns[0]!);

          expect(executor.runWorkflow).toHaveBeenCalledTimes(1);
          expect(executor.runWorkflow.mock.calls[0]?.[0]).toMatchObject({ workflowPath: "notes/daily.md", slotClaim: expect.anything() });
          expect(plugin.missedRuns).toEqual([]);
        });

        // After a sleep both runners look; the user hears of the gap in
        // Obsidian also when the agent recorded it first.
        it("are told of when the agent recorded them first", async () => {
          const { recordMissedSlots } = await vi.importActual<typeof import("@vaultore/core")>("@vaultore/core");
          await recordMissedSlots({ vaultRoot: join(base, "vault"), notePath: "notes/daily.md", schedule: HOURLY, by: "vaultore agent", directory: runLocks.slots });

          await plugin.lookForMissedRuns("notes/daily.md", HOURLY);

          expect(Notice.shown.filter((m) => m.includes("missed"))).toHaveLength(1);
          expect(plugin.missedRuns).toHaveLength(1);
          expect(plugin.missedRuns[0]?.claimedBy.by).toBe("vaultore agent");
        });

        // A slot fired while the note still runs is decided, not dropped.
        it("record a slot fired while the note runs as skipped", async () => {
          const { readSlotRecord } = await vi.importActual<typeof import("@vaultore/core")>("@vaultore/core");
          const file = Object.assign(new TFile(), { path: "notes/daily.md", basename: "daily" });
          (plugin as unknown as { runningWorkflows: Set<string> }).runningWorkflows.add("notes/daily.md");
          const slot = new Date(Date.now() - 1000);

          await (plugin as any).runWorkflow(file, { schedule: HOURLY, slot });

          (plugin as unknown as { runningWorkflows: Set<string> }).runningWorkflows.delete("notes/daily.md");
          const entry = (await readSlotRecord({ directory: runLocks.slots })).find((e) => e.slot.getTime() === slot.getTime());
          expect(entry).toMatchObject({ state: "skipped", reason: "the note was still running" });
          expect(Notice.shown).toEqual([]);
        });

        // Found in the app: arming fired two occurrences at once, and the
        // older one ran. Now only the latest runs; the others are skipped.
        it("run only the latest of occurrences due at once; the others are recorded as skipped", async () => {
          const run = vi.spyOn(plugin as any, "runWorkflowByPath").mockResolvedValue(undefined);
          const skip = vi.spyOn(plugin as any, "recordSkippedSlot").mockResolvedValue(undefined);
          vi.spyOn(plugin as any, "isApprovedSchedule").mockReturnValue(true);
          const scheduler = (plugin as any).scheduler as InstanceType<typeof WorkflowScheduler>;
          scheduler.register("notes/daily.md", "* * * * *").nextRun = new Date(Date.now() - 90_000);

          scheduler.tick();

          expect(run).toHaveBeenCalledTimes(1);
          expect(skip).toHaveBeenCalled();
          const ran = (run.mock.calls[0]?.[1] as { slot: Date }).slot;
          for (const call of skip.mock.calls) expect((call[1] as { slot: Date }).slot.getTime()).toBeLessThan(ran.getTime());
        });

        it("are what a late tick finds, instead of a run", async () => {
          // Between minutes 15 and 18 of an hour, the 15-minute occurrence
          // would fall inside the window and run: the clock is pinned.
          vi.setSystemTime(new Date("2026-11-24T10:40:00.000Z"));
          const look = vi.spyOn(plugin, "lookForMissedRuns").mockResolvedValue(undefined);
          const run = vi.spyOn(plugin as any, "runWorkflowByPath").mockResolvedValue(undefined);
          const scheduler = (plugin as any).scheduler as InstanceType<typeof WorkflowScheduler>;
          scheduler.register("notes/daily.md", HOURLY).nextRun = new Date(Date.now() - 3 * 60_000);
          vi.spyOn(plugin as any, "isApprovedSchedule").mockReturnValue(true);

          scheduler.tick();

          expect(look).toHaveBeenCalledWith("notes/daily.md", HOURLY, expect.any(Date));
          expect(run).not.toHaveBeenCalled();
        });
      });

      // The agent ran this occurrence: not worth a notice every minute.
      it("shows no notice when the other runner had the slot", async () => {
        const { SlotTakenError } = await vi.importActual<typeof import("@vaultore/core")>("@vaultore/core");
        const file = Object.assign(new TFile(), { path: "notes/daily.md", basename: "daily" });
        plugin.app.vault.read = vi.fn().mockResolvedValue("---\nore: true\n---\n") as never;
        const executor = (plugin as unknown as { executor: { runWorkflow: ReturnType<typeof vi.fn> } }).executor;
        executor.runWorkflow.mockRejectedValueOnce(
          new SlotTakenError("notes/daily.md", scheduled.slot, undefined, "The run was claimed by process 7 (vaultore agent). Nothing was run")
        );
        const info = vi.spyOn(console, "info").mockImplementation(() => {});
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        Notice.shown.length = 0;

        await (plugin as any).runWorkflow(file, scheduled);

        expect(Notice.shown).toEqual([]);
        info.mockRestore();
        log.mockRestore();
      });
    });
  });

  describe("scheduler", () => {
    // Registered, the interval is cleared on unload even if stop() never runs.
    // The scheduler's tick, and the minute's re-check of listed missed runs.
    it("registers its intervals with the plugin", () => {
      expect(plugin.registerInterval).toHaveBeenCalledTimes(2);
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
    const tab = at(at(calls));
    tab.display();
    return tab.containerEl.settings;
  }

  function row(name: string): RecordedSetting {
    const found = renderSettings().find((setting) => setting.name === name);
    expect(found, `setting "${name}"`).toBeDefined();
    return found!;
  }

  async function toggle(name: string, value: boolean) {
    await at(row(name).toggles).changeHandler!(value);
  }

  beforeEach(async () => {
    rmSync(machineSettings.path, { force: true });
    rmSync(machineSettings.schedules, { force: true });
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
    // A desktop vault: the scheduling consent is keyed by its root (#276).
    (plugin.app.vault as any).adapter = new FileSystemAdapter();
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
    expect(plugin.schedules).toEqual({ runScheduledWorkflows: false, approvals: {} });
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
    expect(at(master.toggles).value).toBe(false);

    const daily = row("Workflows/daily.md");
    expect(daily.desc).toContain("0 18 * * *");
    expect(daily.desc).toMatch(/not approved/i);
    expect(at(daily.toggles).value).toBe(false);
    expect(settings.map((s) => s.name)).not.toContain("Workflows/manual.md");
    expect(settings.map((s) => s.name)).not.toContain("Notes/plain.md");
  });

  // Obsidian 1.14 does not redraw the description of the row whose own
  // control the user just changed, even after update() (observed in the app,
  // 2026-10-28), so the row updates its own text. The mock re-renders new rows
  // on update(); the row the test holds is the one the user clicked.
  it("updates the clicked note's description itself", async () => {
    useVault({ "Workflows/daily.md": { ore: true, schedule: "0 18 * * *" } });
    const daily = row("Workflows/daily.md");

    await at(daily.toggles).changeHandler!(true);
    expect(daily.desc).toMatch(/Approved; runs once "Run scheduled workflows" is on/);

    await at(daily.toggles).changeHandler!(false);
    expect(daily.desc).toMatch(/Not approved/);
  });

  it("runs a note only with the master switch on and the note approved", async () => {
    useVault({ "Workflows/daily.md": { ore: true, schedule: "0 18 * * *" } });

    await toggle("Workflows/daily.md", true);
    expect(plugin.schedules.approvals).toEqual({ "Workflows/daily.md": "0 18 * * *" });
    expect(armed()).toEqual([]);

    await toggle("Run scheduled workflows", true);
    expect(armed()).toEqual(["Workflows/daily.md 0 18 * * *"]);
    expect(row("Workflows/daily.md").desc).toMatch(/next run/i);

    await toggle("Workflows/daily.md", false);
    expect(plugin.schedules.approvals).toEqual({});
    expect(armed()).toEqual([]);
  });

  // Sync carries data.json and the notes, so neither holds the consent (#276).
  it("keeps the decisions on this machine, in the user tree, not in data.json or the notes", async () => {
    useVault({ "Workflows/daily.md": { ore: true, schedule: "0 18 * * *" } });

    await toggle("Run scheduled workflows", true);
    await toggle("Workflows/daily.md", true);

    expect(JSON.parse(readFileSync(machineSettings.schedules, "utf8")).vaults).toEqual({
      [await (plugin as unknown as { adapter: { getVaultRoot(): Promise<string> } }).adapter.getVaultRoot()]: {
        runScheduledWorkflows: true,
        approvals: { "Workflows/daily.md": "0 18 * * *" },
      },
    });
    for (const [data] of vi.mocked(plugin.saveData).mock.calls) {
      expect(data).not.toHaveProperty("runScheduledWorkflows");
      expect(data).not.toHaveProperty("scheduleApprovals");
    }
    expect(plugin.app.vault.modify).not.toHaveBeenCalled();
  });

  // Loads the plugin again on the same computer (the same app, so the same
  // per-device storage), from this data.json.
  async function reload(data: Record<string, unknown> | null): Promise<ReturnType<typeof vi.spyOn>> {
    const app = plugin.app;
    plugin.onunload();
    plugin = new VaultOrePlugin(undefined as any, undefined as any);
    Object.assign(plugin.app, app);
    vi.spyOn(plugin, "addSettingTab");
    const saved = vi.spyOn(plugin, "saveData");
    vi.spyOn(plugin, "loadData").mockResolvedValue(data);
    await plugin.onload();
    return saved;
  }

  // What an older VaultOre wrote: scheduling on, one note approved.
  const OLD_DATA = {
    runScheduledWorkflows: true,
    scheduleApprovals: { "Workflows/daily.md": "0 18 * * *" },
    defaultModel: "gpt-5-mini",
  };
  const movedNotice = () => Notice.shown.filter((m) => m.includes("now turned on for each account on each computer"));

  // A data.json synced from a machine with an older VaultOre still carries
  // the switch and approvals: they arm nothing here.
  it("arms nothing from a data.json that turns scheduling on", async () => {
    useVault({ "Workflows/daily.md": { ore: true, schedule: "0 18 * * *" } });

    await reload(OLD_DATA);

    expect(plugin.schedules).toEqual({ runScheduledWorkflows: false, approvals: {} });
    expect(armed()).toEqual([]);
  });

  // An older plugin on another computer reads the same data.json: removing
  // the keys would switch its scheduling off before it is upgraded.
  it("keeps the old keys in data.json as found, beside every other setting saved", async () => {
    const saved = await reload(OLD_DATA);
    expect(saved).not.toHaveBeenCalled();

    plugin.settings.defaultModel = "gpt-5";
    await plugin.saveSettings();

    expect(saved.mock.calls[0]?.[0]).toEqual({ ...plugin.settings, ...OLD_DATA, defaultModel: "gpt-5" });
  });

  it("says once on this computer that scheduling is off here, until dismissed", async () => {
    await reload(OLD_DATA);
    expect(movedNotice()).toHaveLength(1);

    await reload(OLD_DATA);
    expect(movedNotice()).toHaveLength(1);
  });

  it("says nothing when scheduling was off before, or is already on here", async () => {
    await reload({ runScheduledWorkflows: false });
    expect(movedNotice()).toEqual([]);

    await toggle("Run scheduled workflows", true);
    await reload(OLD_DATA);
    expect(movedNotice()).toEqual([]);
  });

  it("says in the settings that scheduling was on before, until it is on here", async () => {
    await reload(OLD_DATA);
    expect(row("Run scheduled workflows").desc).toMatch(/Before this version, scheduling was on/);

    await toggle("Run scheduled workflows", true);
    expect(row("Run scheduled workflows").desc).not.toMatch(/Before this version/);
  });

  // Found with #276: a settings.json that cannot be used made onload throw,
  // as the error was logged through an adapter not made yet.
  it("loads with a settings.json or schedules file that cannot be used, and says so", async () => {
    writeFileSync(machineSettings.path, "{broken");
    writeFileSync(machineSettings.schedules, "{broken");
    Notice.shown.length = 0;
    const broken = new VaultOrePlugin(undefined as any, undefined as any);
    vi.spyOn(broken, "addSettingTab");
    vi.spyOn(broken, "saveData");
    vi.spyOn(broken, "loadData").mockResolvedValue(null);
    Object.assign(broken.app, plugin.app);

    await broken.onload();

    expect(broken.schedules.runScheduledWorkflows).toBe(false);
    expect(Notice.shown.some((m) => m.includes("settings.json"))).toBe(true);
    expect(Notice.shown.some((m) => m.includes("obsidian-schedules.json"))).toBe(true);
    broken.onunload();
  });

  // Fail closed: a file that cannot be used turns nothing on, and says so.
  it("keeps scheduling off and says why when the user tree's file cannot be used", async () => {
    writeFileSync(machineSettings.schedules, "{broken");
    Notice.shown.length = 0;

    await plugin.loadSchedules();

    expect(plugin.schedules).toEqual({ runScheduledWorkflows: false, approvals: {} });
    expect(Notice.shown.some((m) => m.includes("scheduled workflows stay off") && m.includes("obsidian-schedules.json"))).toBe(true);
  });

  it("needs a new approval when the schedule changes", async () => {
    useVault({ "Workflows/daily.md": { ore: true, schedule: "0 18 * * *" } });
    await toggle("Run scheduled workflows", true);
    await toggle("Workflows/daily.md", true);

    entry(notes, "Workflows/daily.md").schedule = "* * * * *";
    refresh();

    expect(armed()).toEqual([]);
    const daily = row("Workflows/daily.md");
    expect(at(daily.toggles).value).toBe(false);
    expect(daily.desc).toMatch(/changed from "0 18 \* \* \*" to "\* \* \* \* \*"/);
  });

  it("lists notes that appear later without arming them", async () => {
    useVault({ "Workflows/daily.md": { ore: true, schedule: "0 18 * * *" } });
    await toggle("Run scheduled workflows", true);
    await toggle("Workflows/daily.md", true);

    notes["Inbox/from-sync.md"] = { ore: true, schedule: "* * * * *" };
    refresh();

    expect(armed()).toEqual(["Workflows/daily.md 0 18 * * *"]);
    expect(at(row("Inbox/from-sync.md").toggles).value).toBe(false);
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

    const slot = new Date(Date.now() - 1000);
    at(scheduler().list()).nextRun = slot;
    scheduler().tick();

    // With the occurrence that came due, which names the slot it claims (#255).
    expect(run).toHaveBeenCalledWith("Workflows/daily.md", { schedule: "0 18 * * *", slot });
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

    entry(notes, "Workflows/daily.md").schedule = "* * * * *";
    at(scheduler().list()).nextRun = new Date(Date.now() - 1000);
    scheduler().tick();

    expect(run).not.toHaveBeenCalled();
  });

  it("shows an invalid schedule and warns once instead of swallowing it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    useVault({ "Workflows/typo.md": { ore: true, schedule: "every day" } });
    await toggle("Run scheduled workflows", true);
    await plugin.setScheduleApproval("Workflows/typo.md", "every day");

    refresh();
    refresh();

    expect(armed()).toEqual([]);
    // Once for this note (the record of /mock-vault, which does not exist, warns apart).
    expect(warn.mock.calls.filter((call) => String(call).includes("Workflows/typo.md"))).toHaveLength(1);
    expect(Notice.shown.filter((m) => m.includes("Workflows/typo.md"))).toHaveLength(1);
    const typo = row("Workflows/typo.md");
    expect(typo.desc).toMatch(/invalid/i);
    expect(at(typo.toggles).disabled).toBe(true);
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

    // The handlers drop it without waiting, both at once; the plugin's queue
    // writes one after the other (found with #276: the second was refused).
    await vi.waitFor(() => expect(plugin.schedules.approvals).toEqual({}));
    expect(Notice.shown.filter((m) => m.includes("could not save"))).toEqual([]);
    expect(JSON.parse(readFileSync(machineSettings.schedules, "utf8")).vaults).toEqual({});
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
    // version is one of them, and the manifest's minAppVersion is at least
    // the one that version was released with. The file is legally empty before
    // the first release; version-bump.mjs adds the entry when `bun run
    // release` cuts one, and at no other time.
    //
    // Why: an Obsidian app older than the manifest's minAppVersion falls back
    // to the newest plugin version this map lists for it (docs.obsidian.md,
    // Reference/Versions, read 2026-10-15), so an entry must name a version
    // that was actually released. Between releases, minAppVersion may be
    // raised ahead of the next one (#137); release-tag.mjs requires the exact
    // match when that release is tagged.
    const manifestPath = path.resolve(__dirname, "../../../manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

    if (Object.keys(versions).length > 0) {
      expect(versions[manifest.version]).toBeDefined();
      expect(
        compareVersions(manifest.minAppVersion, versions[manifest.version])
      ).toBeGreaterThanOrEqual(0);
    }
  });

  it("orders versions by number, not as text", () => {
    expect(compareVersions("1.13.0", "1.11.4")).toBeGreaterThan(0);
    expect(compareVersions("1.9.0", "1.13.0")).toBeLessThan(0);
    expect(compareVersions("1.13.0", "1.13.0")).toBe(0);
  });
});

/** The element at `index` of `items`, failing the test when there is none. */
function at<T>(items: readonly T[], index = 0): T {
  const item = items[index];
  if (item === undefined) throw new Error(`expected an element at index ${index}, found ${items.length}`);
  return item;
}

/** The entry `key` of `record`, failing the test when there is none. */
function entry<T>(record: Record<string, T>, key: string): T {
  const value = record[key];
  if (value === undefined) throw new Error(`expected an entry ${key}`);
  return value;
}

/** Negative, zero or positive as semver triple `a` is below, equal to or above `b`. */
function compareVersions(a: string, b: string): number {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    // A missing part counts as 0: 1.13 is 1.13.0.
    const diff = (x[i] ?? 0) - (y[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

describe("Obsidian version", () => {
  // The settings tab is declarative only (#137): getSettingDefinitions() and
  // SettingTab.update() first exist in 1.13.0, and the tab has no display()
  // for older apps.
  it("requires Obsidian 1.13.0 or later", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const manifest = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, "../manifest.json"), "utf8")
    );
    expect(compareVersions(manifest.minAppVersion, "1.13.0")).toBeGreaterThanOrEqual(0);
  });
});
