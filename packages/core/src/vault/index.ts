/**
 * @vaultore/core - Vault API
 *
 * BRICK-026: Vault API helpers
 *
 * Provides the runtime API available inside ore:ts cells:
 * - vault.read(), vault.write(), vault.exists(), vault.mkdirp()
 * - cell() for accessing other cell outputs
 * - vault.readRaw() for container paths like /proc
 */

import { PlatformAdapter, CellOutput } from "../types";

// =============================================================================
// VAULT API
// =============================================================================

/**
 * Vault API available inside ore:ts cells
 */
export interface VaultAPI {
  /**
   * Read a note from the vault
   * @param path Path to the note (relative to vault root)
   */
  read(path: string): Promise<string>;

  /**
   * Write a note to the vault
   * @param path Path to the note
   * @param content Content to write
   */
  write(path: string, content: string): Promise<void>;

  /**
   * Check if a note exists
   * @param path Path to the note
   */
  exists(path: string): Promise<boolean>;

  /**
   * Create directories (like mkdir -p)
   * @param path Directory path to create
   */
  mkdirp(path: string): Promise<void>;

  /**
   * Read raw container paths (for /proc, etc.)
   * @param path Absolute path in container
   */
  readRaw(path: string): Promise<string>;
}

/**
 * Cell reference function available inside ore:ts cells
 */
export type CellFn = (id: string) => unknown;

// =============================================================================
// VAULT API IMPLEMENTATION
// =============================================================================

/**
 * Create a VaultAPI instance for use in cell execution
 */
export function createVaultAPI(
  platform: PlatformAdapter,
  permissions: {
    vaultRead: boolean;
    vaultWrite: boolean;
  }
): VaultAPI {
  return {
    async read(path: string): Promise<string> {
      if (!permissions.vaultRead) {
        throw new VaultError("Vault read permission denied");
      }

      // Normalize path (relative to vault root)
      const normalizedPath = normalizePath(path);
      return platform.readFile(normalizedPath);
    },

    async write(path: string, content: string): Promise<void> {
      if (!permissions.vaultWrite) {
        throw new VaultError("Vault write permission denied");
      }

      const normalizedPath = normalizePath(path);
      await platform.writeFile(normalizedPath, content);
    },

    async exists(path: string): Promise<boolean> {
      if (!permissions.vaultRead) {
        throw new VaultError("Vault read permission denied");
      }

      const normalizedPath = normalizePath(path);
      return platform.exists(normalizedPath);
    },

    async mkdirp(path: string): Promise<void> {
      if (!permissions.vaultWrite) {
        throw new VaultError("Vault write permission denied");
      }

      const normalizedPath = normalizePath(path);
      await platform.mkdirp(normalizedPath);
    },

    async readRaw(path: string): Promise<string> {
      // readRaw is for container paths like /proc
      // This requires a special platform method
      if (!platform.readRaw) {
        throw new VaultError("readRaw not supported on this platform");
      }
      return platform.readRaw(path);
    },
  };
}

/**
 * Create a cell() function for accessing other cell outputs
 */
export function createCellFn(outputs: Map<string, CellOutput>): CellFn {
  return (id: string): unknown => {
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

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Normalize a path (remove leading /, handle ..)
 */
function normalizePath(path: string): string {
  // Remove leading slash if present
  const normalized = path.startsWith("/") ? path.slice(1) : path;

  // Split and filter out empty parts and resolve ..
  const parts = normalized.split("/").filter(Boolean);
  const resolved: string[] = [];

  for (const part of parts) {
    if (part === "..") {
      resolved.pop();
    } else if (part !== ".") {
      resolved.push(part);
    }
  }

  return resolved.join("/");
}

// =============================================================================
// RUNTIME SCRIPT GENERATION
// =============================================================================

/**
 * JavaScript source for the cells' outputs, as a Map from cell id to value.
 *
 * The outputs travel as one JSON string that the script parses, never as an
 * object literal: in a literal the key `__proto__` sets the prototype instead
 * of an entry, and a lookup on an object answers for every name it inherits
 * (`constructor`, `toString`), so `cell()` returned things no cell put out
 * (#223). In a Map an id is data, whatever it is.
 *
 * A value JSON has no form for (undefined) is no entry, as it was no key when
 * the outputs were a JSON object: `cell()` then says the output was not found.
 */
export function cellOutputsSource(cellOutputs: Map<string, CellOutput>): string {
  const entries = Array.from(cellOutputs.entries())
    .map(([id, output]): [string, unknown] => [id, output.value])
    .filter(([, value]) => JSON.stringify(value) !== undefined);
  return `new Map(JSON.parse(${JSON.stringify(JSON.stringify(entries))}))`;
}

/**
 * Generate the runtime script injected into ore:ts cells
 *
 * This creates the `vault` and `cell` globals available in user code.
 */
export function generateRuntimeScript(
  cellOutputs: Map<string, CellOutput>,
  permissions: { vaultRead?: boolean; vaultWrite?: boolean } = {}
): string {
  const outputsSource = cellOutputsSource(cellOutputs);

  const vaultRead = permissions.vaultRead ?? true;
  const vaultWrite = permissions.vaultWrite ?? false;

  return `
// VaultOre Runtime Injection
const __vaultore_outputs = ${outputsSource};
const __vaultore_permissions = { vaultRead: ${vaultRead}, vaultWrite: ${vaultWrite} };

function cell(id) {
  const key = String(id);
  if (!__vaultore_outputs.has(key)) {
    throw new Error(\`Cell output not found: \${key}\`);
  }
  return __vaultore_outputs.get(key);
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

// =============================================================================
// ERRORS
// =============================================================================

export class VaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultError";
  }
}

// =============================================================================
// EXPORTS
// =============================================================================

export { normalizePath };
