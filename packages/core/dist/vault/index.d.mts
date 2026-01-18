import { o as PlatformAdapter, k as CellOutput } from '../index-DIxOf9vK.mjs';
import 'zod';

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

/**
 * Vault API available inside ore:ts cells
 */
interface VaultAPI {
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
type CellFn = (id: string) => unknown;
/**
 * Create a VaultAPI instance for use in cell execution
 */
declare function createVaultAPI(platform: PlatformAdapter, permissions: {
    vaultRead: boolean;
    vaultWrite: boolean;
}): VaultAPI;
/**
 * Create a cell() function for accessing other cell outputs
 */
declare function createCellFn(outputs: Map<string, CellOutput>): CellFn;
/**
 * Normalize a path (remove leading /, handle ..)
 */
declare function normalizePath(path: string): string;
/**
 * Generate the runtime script injected into ore:ts cells
 *
 * This creates the `vault` and `cell` globals available in user code.
 */
declare function generateRuntimeScript(cellOutputs: Map<string, CellOutput>, permissions?: {
    vaultRead?: boolean;
    vaultWrite?: boolean;
}): string;
declare class VaultError extends Error {
    constructor(message: string);
}

export { type CellFn, type VaultAPI, VaultError, createCellFn, createVaultAPI, generateRuntimeScript, normalizePath };
