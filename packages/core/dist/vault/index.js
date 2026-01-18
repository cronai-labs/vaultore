'use strict';

// src/vault/index.ts
function createVaultAPI(platform, permissions) {
  return {
    async read(path) {
      if (!permissions.vaultRead) {
        throw new VaultError("Vault read permission denied");
      }
      const normalizedPath = normalizePath(path);
      return platform.readFile(normalizedPath);
    },
    async write(path, content) {
      if (!permissions.vaultWrite) {
        throw new VaultError("Vault write permission denied");
      }
      const normalizedPath = normalizePath(path);
      await platform.writeFile(normalizedPath, content);
    },
    async exists(path) {
      if (!permissions.vaultRead) {
        throw new VaultError("Vault read permission denied");
      }
      const normalizedPath = normalizePath(path);
      return platform.exists(normalizedPath);
    },
    async mkdirp(path) {
      if (!permissions.vaultWrite) {
        throw new VaultError("Vault write permission denied");
      }
      const normalizedPath = normalizePath(path);
      await platform.mkdirp(normalizedPath);
    },
    async readRaw(path) {
      if (!platform.readRaw) {
        throw new VaultError("readRaw not supported on this platform");
      }
      return platform.readRaw(path);
    }
  };
}
function createCellFn(outputs) {
  return (id) => {
    const output = outputs.get(id);
    if (!output) {
      throw new VaultError(`Cell output not found: ${id}`);
    }
    if (output.meta.status !== "success") {
      throw new VaultError(`Cell ${id} failed: ${output.meta.error}`);
    }
    return output.value;
  };
}
function normalizePath(path) {
  let normalized = path.startsWith("/") ? path.slice(1) : path;
  const parts = normalized.split("/").filter(Boolean);
  const resolved = [];
  for (const part of parts) {
    if (part === "..") {
      resolved.pop();
    } else if (part !== ".") {
      resolved.push(part);
    }
  }
  return resolved.join("/");
}
function generateRuntimeScript(cellOutputs, permissions = {}) {
  const outputsJson = JSON.stringify(
    Object.fromEntries(
      Array.from(cellOutputs.entries()).map(([id, output]) => [
        id,
        output.value
      ])
    )
  );
  const vaultRead = permissions.vaultRead ?? true;
  const vaultWrite = permissions.vaultWrite ?? false;
  return `
// VaultOre Runtime Injection
const __vaultore_outputs = ${outputsJson};
const __vaultore_permissions = { vaultRead: ${vaultRead}, vaultWrite: ${vaultWrite} };

function cell(id) {
  if (!(id in __vaultore_outputs)) {
    throw new Error(\`Cell output not found: \${id}\`);
  }
  return __vaultore_outputs[id];
}

const vault = {
  async read(path) {
    if (!__vaultore_permissions.vaultRead) {
      throw new Error("Vault read permission denied");
    }
    return await Bun.file("/workspace/" + path.replace(/^\\//, "")).text();
  },
  async write(path, content) {
    if (!__vaultore_permissions.vaultWrite) {
      throw new Error("Vault write permission denied");
    }
    await Bun.write("/workspace/" + path.replace(/^\\//, ""), content);
  },
  async exists(path) {
    if (!__vaultore_permissions.vaultRead) {
      throw new Error("Vault read permission denied");
    }
    return await Bun.file("/workspace/" + path.replace(/^\\//, "")).exists();
  },
  async mkdirp(path) {
    if (!__vaultore_permissions.vaultWrite) {
      throw new Error("Vault write permission denied");
    }
    const proc = Bun.spawn(["mkdir", "-p", "/workspace/" + path.replace(/^\\//, "")]);
    await proc.exited;
  },
  async readRaw(path) {
    return await Bun.file(path).text();
  },
};
`;
}
var VaultError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "VaultError";
  }
};

exports.VaultError = VaultError;
exports.createCellFn = createCellFn;
exports.createVaultAPI = createVaultAPI;
exports.generateRuntimeScript = generateRuntimeScript;
exports.normalizePath = normalizePath;
//# sourceMappingURL=index.js.map
//# sourceMappingURL=index.js.map