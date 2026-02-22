import { describe, it, expect, vi, beforeEach } from "vitest";

// ---- Core module mock (before importing main) ----
vi.mock("@vaultore/core", () => ({
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
  },
}));

// Import the plugin — obsidian is aliased via vitest.config.ts
const { default: VaultOrePlugin } = await import("./main");

describe("VaultOrePlugin", () => {
  let plugin: InstanceType<typeof VaultOrePlugin>;

  beforeEach(async () => {
    plugin = new VaultOrePlugin(undefined as any, undefined as any);
    // Spy on mock methods from the base class
    vi.spyOn(plugin, "addCommand");
    vi.spyOn(plugin, "addSettingTab");
    vi.spyOn(plugin, "registerEvent");
    vi.spyOn(plugin, "saveData");
    vi.spyOn(plugin, "loadData").mockResolvedValue(null);

    await plugin.onload();
  });

  describe("onload", () => {
    it("registers three commands", () => {
      expect(plugin.addCommand).toHaveBeenCalledTimes(3);

      const calls = (plugin.addCommand as ReturnType<typeof vi.fn>).mock.calls;
      const ids = calls.map((c: [{ id: string }]) => c[0].id);
      expect(ids).toContain("vaultore-run-all");
      expect(ids).toContain("vaultore-run-cell");
      expect(ids).toContain("vaultore-run-cell-only");
    });

    it("registers a settings tab", () => {
      expect(plugin.addSettingTab).toHaveBeenCalledTimes(1);
    });

    it("registers vault modify event handler", () => {
      expect(plugin.registerEvent).toHaveBeenCalled();
    });
  });

  describe("settings", () => {
    it("loads with defaults when no saved data", () => {
      expect(plugin.settings.defaultProvider).toBe("openai");
      expect(plugin.settings.defaultModel).toBe("gpt-5-mini");
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
  });

  describe("secret management", () => {
    it("delegates setSecretValue to adapter", async () => {
      const setSecret = vi.fn();
      plugin.app.secretStorage = {
        getSecret: vi.fn(),
        setSecret,
      };

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
      };

      await plugin.deleteSecretValue("openai.apiKey");

      expect(setSecret).toHaveBeenCalledWith("vaultore-openai-apikey", "");
    });
  });

  describe("onunload", () => {
    it("completes without error", () => {
      expect(() => plugin.onunload()).not.toThrow();
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
});
