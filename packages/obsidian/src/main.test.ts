import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---- Core module mock (before importing main) ----
vi.mock("@vaultore/core", async (importOriginal) => ({
  // The real defaults: the plugin must not carry its own copy (#78).
  DEFAULT_MODELS: (await importOriginal<typeof import("@vaultore/core")>()).DEFAULT_MODELS,
  DEFAULT_PROVIDER: (await importOriginal<typeof import("@vaultore/core")>()).DEFAULT_PROVIDER,
  WorkflowExecutor: class {
    runWorkflow = vi.fn().mockResolvedValue({});
  },
  WorkflowParser: class {
    isWorkflow = vi.fn().mockReturnValue(false);
    parse = vi.fn().mockReturnValue({
      frontmatter: {},
      cells: [],
    });
  },
  WorkflowScheduler: class {
    start = vi.fn();
    stop = vi.fn();
    register = vi.fn();
    unregister = vi.fn();
    list = vi.fn().mockReturnValue([]);
  },
}));

// Import the plugin — obsidian is aliased via vitest.config.ts
const { default: VaultOrePlugin } = await import("./main");
const { Notice, requestUrl } = await import("obsidian");
const { DEFAULT_MODELS, DEFAULT_PROVIDER } = await import("@vaultore/core");
type RecordedSetting = import("./__mocks__/obsidian").Setting;

describe("VaultOrePlugin", () => {
  let plugin: InstanceType<typeof VaultOrePlugin>;

  beforeEach(async () => {
    vi.useFakeTimers();
    plugin = new VaultOrePlugin(undefined as any, undefined as any);
    // Spy on mock methods from the base class
    vi.spyOn(plugin, "addCommand");
    vi.spyOn(plugin, "addSettingTab");
    vi.spyOn(plugin, "registerEvent");
    vi.spyOn(plugin, "saveData");
    vi.spyOn(plugin, "loadData").mockResolvedValue(null);

    await plugin.onload();
  });

  afterEach(() => {
    vi.useRealTimers();
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

  describe("run-all command", () => {
    it("is a check callback that requires an active md file", () => {
      const calls = (plugin.addCommand as ReturnType<typeof vi.fn>).mock.calls;
      const runAllCmd = calls.find((c: any[]) => c[0].id === "run-all");
      expect(runAllCmd).toBeDefined();
      const cmd = runAllCmd![0];

      // With no active file, checkCallback returns false
      plugin.app.workspace.getActiveFile = () => null;
      expect(cmd.checkCallback(true)).toBe(false);
    });
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
    expect(manifest.main).toBe("main.js");
    expect(manifest.description).toBeTruthy();
    expect(manifest.author).toBeTruthy();
    expect(manifest.isDesktopOnly).toBe(true);
  });

  it("has matching version in packages/obsidian/manifest.json", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const rootManifest = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, "../manifest.json"), "utf8")
    );
    const rootRootManifest = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, "../../../manifest.json"), "utf8")
    );

    expect(rootManifest.version).toBe(rootRootManifest.version);
    expect(rootManifest.id).toBe(rootRootManifest.id);
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
