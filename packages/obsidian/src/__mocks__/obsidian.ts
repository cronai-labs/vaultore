// Minimal mock of the Obsidian API for unit testing.
// Only the types/classes that VaultOre actually uses are mocked.

import { vi } from "vitest";

/** Tests set the response with `vi.mocked(requestUrl).mockResolvedValue(...)`. */
export const requestUrl = vi.fn();

export class Plugin {
  app: any = {
    vault: {
      adapter: {
        read: async () => "",
        write: async () => {},
        stat: async () => null,
        mkdir: async () => {},
        exists: async () => false,
        list: async () => ({ files: [], folders: [] }),
        getBasePath: () => "/mock-vault",
      },
      getAbstractFileByPath: () => null,
      getFiles: () => [],
      getMarkdownFiles: () => [],
      read: async () => "",
      modify: async () => {},
      create: async () => {},
      createFolder: async () => {},
      // Handlers registered with on(), by event name, so tests can fire them.
      handlers: {} as Record<string, Array<(...args: any[]) => unknown>>,
      on(name: string, cb: (...args: any[]) => unknown) {
        (this.handlers[name] ??= []).push(cb);
        return { unload: () => {} };
      },
    },
    workspace: {
      getActiveFile: () => null,
      onLayoutReady: (cb: () => void) => cb(),
    },
    metadataCache: {
      getFileCache: () => null,
      on: () => ({ unload: () => {} }),
    },
    secretStorage: {
      getSecret: () => null,
      setSecret: () => {},
    },
  };
  manifest = { id: "mock", name: "Mock" };
  async loadData() {
    return null;
  }
  async saveData(_data: any) {}
  addCommand(_cmd: any) {}
  addSettingTab(_tab: any) {}
  registerEvent(_event: any) {}
}

// The settings mocks record what a tab renders, so tests can assert on the
// visible settings (names, descriptions, toggles) and drive their handlers.
export class MockContainer {
  settings: Setting[] = [];
  empty() {
    this.settings.length = 0;
  }
  createEl() {
    return {};
  }
  createDiv() {
    return new MockContainer();
  }
}

export class PluginSettingTab {
  app: any;
  plugin: any;
  containerEl = new MockContainer();
  constructor(app: any, plugin: any) {
    this.app = app;
    this.plugin = plugin;
  }
}

export class MockValueComponent<T = unknown> {
  value: T | undefined;
  disabled = false;
  options: string[] = [];
  changeHandler?: (value: T) => unknown;
  setValue(value: T) {
    this.value = value;
    return this;
  }
  getValue() {
    return this.value;
  }
  onChange(cb: (value: T) => unknown) {
    this.changeHandler = cb;
    return this;
  }
  setPlaceholder(_value: string) {
    return this;
  }
  addOption(value: string, _label: string) {
    this.options.push(value);
    return this;
  }
  setDisabled(disabled: boolean) {
    this.disabled = disabled;
    return this;
  }
  setTooltip(_tooltip: string) {
    return this;
  }
}

export class MockButtonComponent {
  text = "";
  disabled = false;
  clickHandler?: () => unknown;
  setButtonText(text: string) {
    this.text = text;
    return this;
  }
  onClick(cb: () => unknown) {
    this.clickHandler = cb;
    return this;
  }
  setDisabled(disabled: boolean) {
    this.disabled = disabled;
    return this;
  }
  setCta() {
    return this;
  }
  setWarning() {
    return this;
  }
  setTooltip(_tooltip: string) {
    return this;
  }
}

export class Setting {
  name = "";
  desc = "";
  heading = false;
  toggles: MockValueComponent<boolean>[] = [];
  texts: MockValueComponent<string>[] = [];
  dropdowns: MockValueComponent<string>[] = [];
  buttons: MockButtonComponent[] = [];
  components: unknown[] = [];

  constructor(containerEl: any) {
    if (containerEl instanceof MockContainer) {
      containerEl.settings.push(this);
    }
  }
  setName(name: string) {
    this.name = name;
    return this;
  }
  setDesc(desc: string) {
    this.desc = desc;
    return this;
  }
  setHeading() {
    this.heading = true;
    return this;
  }
  setClass(_cls: string) {
    return this;
  }
  setDisabled(_disabled: boolean) {
    return this;
  }
  addToggle(cb: (toggle: MockValueComponent<boolean>) => unknown) {
    const toggle = new MockValueComponent<boolean>();
    this.toggles.push(toggle);
    cb(toggle);
    return this;
  }
  addText(cb: (text: MockValueComponent<string>) => unknown) {
    const text = new MockValueComponent<string>();
    this.texts.push(text);
    cb(text);
    return this;
  }
  addDropdown(cb: (dropdown: MockValueComponent<string>) => unknown) {
    const dropdown = new MockValueComponent<string>();
    this.dropdowns.push(dropdown);
    cb(dropdown);
    return this;
  }
  addButton(cb: (button: MockButtonComponent) => unknown) {
    const button = new MockButtonComponent();
    this.buttons.push(button);
    cb(button);
    return this;
  }
  addComponent(cb: (el: unknown) => unknown) {
    this.components.push(cb({}));
    return this;
  }
}

export class Modal {
  app: any;
  contentEl = {
    createEl: (_tag: string, _opts?: any) => ({
      addEventListener: () => {},
    }),
    createDiv: (_opts?: any) => ({
      createEl: (_tag: string, _opts2?: any) => ({
        addEventListener: () => {},
      }),
    }),
    empty: () => {},
  };
  constructor(app: any) {
    this.app = app;
  }
  open() {}
  close() {}
  onOpen() {}
  onClose() {}
}

export class Notice {
  // Every message shown, in order, so tests can assert on user-facing notices.
  static shown: string[] = [];
  message: string;
  constructor(message: string, _timeout?: number) {
    this.message = message;
    Notice.shown.push(message);
  }
  setMessage(message: string) {
    this.message = message;
  }
  hide() {}
}

export class TFile {
  path = "";
  extension = "md";
  basename = "";
  name = "";
  parent = null;
  stat = { ctime: 0, mtime: 0, size: 0 };
  vault: any = null;
}

export class FileSystemAdapter {
  getBasePath(): string {
    return "/mock-vault";
  }
}

export class SecretComponent extends MockValueComponent<string | null> {
  constructor(_app: any, _el: any) {
    super();
  }
}
