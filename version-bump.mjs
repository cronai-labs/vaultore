/**
 * Version bump script for VaultOre.
 *
 * Syncs the version across every file that carries one, so that a release tag,
 * both Obsidian manifests, all three package manifests, the runtime VERSION
 * constant and versions.json can never drift apart.
 *
 * Usage:
 *   bun run version:bump 0.2.0
 *   node version-bump.mjs 0.2.0
 *
 * Releases are cut by pushing the matching tag; .github/workflows/release.yml
 * refuses to publish when the tag and the manifests disagree.
 */
import { readFileSync, writeFileSync } from "fs";

const targetVersion = process.argv[2] || process.env.npm_package_version;

if (!targetVersion) {
  console.error("Usage: node version-bump.mjs <version>");
  console.error("  e.g. node version-bump.mjs 0.2.0");
  process.exit(1);
}

if (!/^\d+\.\d+\.\d+$/.test(targetVersion)) {
  console.error(`Invalid semver: "${targetVersion}". Expected format: X.Y.Z`);
  process.exit(1);
}

function updateJson(filePath, updater) {
  const content = JSON.parse(readFileSync(filePath, "utf8"));
  updater(content);
  writeFileSync(filePath, JSON.stringify(content, null, "\t") + "\n");
  console.log(`  updated ${filePath}`);
}

console.log(`Bumping to ${targetVersion}...\n`);

// 1. Root package.json
updateJson("package.json", (pkg) => {
  pkg.version = targetVersion;
});

// 2. Root manifest.json (Obsidian reads this)
updateJson("manifest.json", (manifest) => {
  manifest.version = targetVersion;
});

// 3. packages/obsidian/manifest.json
updateJson("packages/obsidian/manifest.json", (manifest) => {
  manifest.version = targetVersion;
});

// 4. packages/core/package.json
updateJson("packages/core/package.json", (pkg) => {
  pkg.version = targetVersion;
});

// 5. packages/obsidian/package.json
updateJson("packages/obsidian/package.json", (pkg) => {
  pkg.version = targetVersion;
});

// 5b. packages/cli/package.json
updateJson("packages/cli/package.json", (pkg) => {
  pkg.version = targetVersion;
});

// 6. versions.json (additive — maps plugin version to minAppVersion)
const rootManifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const { minAppVersion } = rootManifest;

updateJson("versions.json", (versions) => {
  versions[targetVersion] = minAppVersion;
});

// 7. The VERSION constant the CLI and library report at runtime
const versionModule = "packages/core/src/index.ts";
const source = readFileSync(versionModule, "utf8");
const pattern = /^export const VERSION = "\d+\.\d+\.\d+";$/m;

if (!pattern.test(source)) {
  console.error(`Could not find the VERSION constant in ${versionModule}`);
  process.exit(1);
}

writeFileSync(versionModule, source.replace(pattern, `export const VERSION = "${targetVersion}";`));
console.log(`  updated ${versionModule}`);

console.log(`\nDone. Version ${targetVersion} (minAppVersion: ${minAppVersion})`);
