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
  // Obsidian clears registered intervals on unload and returns the id.
  registerInterval(id: number): number {
    return id;
  }
}

// Obsidian's global createFragment, reduced to the text it would show.
class MockFragment {
  textContent = "";
  appendText(text: string) {
    this.textContent += text;
  }
  createEl(_tag: string, options?: { text?: string }) {
    this.textContent += options?.text ?? "";
    return {};
  }
}
(globalThis as any).createFragment = (
  callback?: (fragment: MockFragment) => void,
) => {
  const fragment = new MockFragment();
  callback?.(fragment);
  return fragment;
};

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

// Renders getSettingDefinitions() the way Obsidian 1.13+ does, reduced to the
// recorded rows: a heading row per group, a row per definition, controls wired
// through getControlValue, validate and setControlValue, and `render` items
// called with their row. update() re-renders, so a test sees the state after a
// change. This is the mock's reading of the API, not Obsidian's code.
export class PluginSettingTab {
  app: any;
  plugin: any;
  containerEl = new MockContainer();
  constructor(app: any, plugin: any) {
    this.app = app;
    this.plugin = plugin;
  }
  getSettingDefinitions(): any[] {
    return [];
  }
  getControlValue(key: string): unknown {
    return this.plugin.settings[key];
  }
  async setControlValue(key: string, value: unknown): Promise<void> {
    this.plugin.settings[key] = value;
    await this.plugin.saveData(this.plugin.settings);
  }
  update() {
    this.display();
  }
  refreshDomState() {}
  display() {
    this.containerEl.empty();
    renderDefinitions(this, this.getSettingDefinitions(), this.containerEl);
  }
}

const evaluate = (value: unknown, fallback: boolean): boolean =>
  typeof value === "function" ? value() : typeof value === "boolean" ? value : fallback;

function renderDefinitions(tab: PluginSettingTab, items: any[], container: MockContainer) {
  for (const item of items) {
    if (!evaluate(item.visible, true)) continue;
    if (item.type === "group" || item.type === "list") {
      if (item.heading) new Setting(container).setName(item.heading).setHeading();
      renderDefinitions(tab, item.items ?? [], container);
      continue;
    }
    if (item.type === "page") {
      throw new Error("The mock does not render setting pages");
    }
    const setting = new Setting(container).setName(item.name);
    if (item.desc !== undefined) setting.setDesc(item.desc);
    setting.searchable = evaluate(item.searchable, true);
    if (item.render) {
      item.render(setting, {});
    } else if (item.control) {
      addControl(tab, setting, item.control);
    }
  }
}

function addControl(tab: PluginSettingTab, setting: Setting, control: any) {
  const wire = (component: MockValueComponent<any>) => {
    component.setValue(tab.getControlValue(control.key) ?? control.defaultValue);
    component.setDisabled(evaluate(control.disabled, false));
    if (control.placeholder) component.setPlaceholder(control.placeholder);
    component.onChange(async (value: unknown) => {
      const error = await control.validate?.(value);
      setting.error = error || "";
      if (error) return;
      await tab.setControlValue(control.key, value);
    });
  };
  switch (control.type) {
    case "toggle":
      setting.addToggle(wire);
      break;
    case "text":
      setting.addText(wire);
      break;
    case "dropdown":
      setting.addDropdown((dropdown) => {
        for (const [value, label] of Object.entries(control.options as Record<string, string>)) {
          dropdown.addOption(value, label);
        }
        wire(dropdown);
      });
      break;
    default:
      throw new Error(`The mock does not render "${control.type}" controls`);
  }
}

export class MockValueComponent<T = unknown> {
  value: T | undefined;
  disabled = false;
  placeholder = "";
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
  setPlaceholder(value: string) {
    this.placeholder = value;
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
  /** Whether Obsidian's settings search may find the row. */
  searchable = true;
  /** The message a control's `validate` returned for the last change. */
  error = "";
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
  setDesc(desc: string | MockFragment) {
    this.desc = typeof desc === "string" ? desc : desc.textContent;
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
