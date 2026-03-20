// Minimal mock of the Obsidian API for unit testing.
// Only the types/classes that VaultOre actually uses are mocked.

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
      on: () => ({ unload: () => {} }),
    },
    workspace: {
      getActiveFile: () => null,
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

export class PluginSettingTab {
  app: any;
  plugin: any;
  containerEl = {
    empty: () => {},
    createEl: () => ({}),
  };
  constructor(app: any, plugin: any) {
    this.app = app;
    this.plugin = plugin;
  }
}

export class Setting {
  constructor(_el: any) {
    return new Proxy(this, {
      get: () => {
        const chainable = (): any => chainable;
        chainable.setValue = chainable;
        chainable.onChange = chainable;
        chainable.setPlaceholder = chainable;
        chainable.setDesc = chainable;
        chainable.setName = chainable;
        chainable.addDropdown = chainable;
        chainable.addText = chainable;
        chainable.addToggle = chainable;
        chainable.addComponent = chainable;
        chainable.addButton = chainable;
        chainable.addOption = chainable;
        chainable.setButtonText = chainable;
        chainable.onClick = chainable;
        return chainable;
      },
    });
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
  message: string;
  constructor(message: string, _timeout?: number) {
    this.message = message;
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

export class SecretComponent {
  constructor(_app: any, _el: any) {}
  onChange(_cb: (value: string) => void) {
    return this;
  }
  setValue(_value: string) {
    return this;
  }
}
