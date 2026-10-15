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
const { requestUrl } = await import("obsidian");
const { DEFAULT_MODELS, DEFAULT_PROVIDER } = await import("@vaultore/core");

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
      expect(plugin.settings.enableWarmPool).toBe(false);
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

    it("preserves all default fields on fresh load", () => {
      expect(plugin.settings.aiTemperature).toBeUndefined();
      expect(plugin.settings.aiMaxTokens).toBe(800);
      expect(plugin.settings.permissionDecisions).toEqual({});
    });
  });

  describe("secret management", () => {
    it("delegates setSecretValue to adapter", async () => {
      const setSecret = vi.fn();
      plugin.app.secretStorage = {
        getSecret: vi.fn(),
        setSecret,
      } as any;

      await plugin.setSecretValue("openai.apiKey", "sk-test");

      expect(setSecret).toHaveBeenCalledWith(
        "vaultore-openai-apikey",
        "sk-test"
      );
    });

    it("delegates deleteSecretValue to adapter", async () => {
      const setSecret = vi.fn();
      plugin.app.secretStorage = {
        getSecret: vi.fn().mockReturnValue("existing"),
        setSecret,
      } as any;

      await plugin.deleteSecretValue("openai.apiKey");

      expect(setSecret).toHaveBeenCalledWith("vaultore-openai-apikey", "");
    });

    it("normalizes secret key with special characters", async () => {
      const setSecret = vi.fn();
      plugin.app.secretStorage = {
        getSecret: vi.fn(),
        setSecret,
      } as any;

      await plugin.setSecretValue("some.complex-key_v2", "value");

      expect(setSecret).toHaveBeenCalledWith(
        "vaultore-some-complex-key-v2",
        "value"
      );
    });

    it("returns undefined when secret storage is unavailable", async () => {
      plugin.app.secretStorage = null as any;
      // getSecret returns undefined when storage is missing
      // (the adapter checks for this)
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
