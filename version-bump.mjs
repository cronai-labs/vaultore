/**
 * Version bump script for VaultOre.
 *
 * Syncs the version across all manifests and updates versions.json.
 *
 * Usage:
 *   node version-bump.mjs <version>        # explicit version
 *   npm version patch                       # via npm lifecycle (reads npm_package_version)
 *
 * This is a fallback for manual releases. The primary flow is release-please,
 * which updates versions via its extra-files config and the release-please.yml
 * workflow handles versions.json separately.
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

// 6. versions.json (additive — maps plugin version to minAppVersion)
const rootManifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const { minAppVersion } = rootManifest;

updateJson("versions.json", (versions) => {
  versions[targetVersion] = minAppVersion;
});

// 7. .release-please-manifest.json
updateJson(".release-please-manifest.json", (manifest) => {
  manifest["."] = targetVersion;
});

console.log(`\nDone. Version ${targetVersion} (minAppVersion: ${minAppVersion})`);
