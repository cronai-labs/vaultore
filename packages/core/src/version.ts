/**
 * The version the CLI and library report at runtime, and the `<version>` in
 * the `vaultore/<version>` actor written to output notes. A literal so it
 * survives bundling; version-bump.mjs rewrites it and version.test.ts fails
 * the build when it drifts from package.json.
 */
export const VERSION = "0.1.2";
