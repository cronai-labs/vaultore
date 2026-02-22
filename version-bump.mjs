import { readFileSync, writeFileSync } from "fs";

const targetVersion = process.env.npm_package_version;

if (!targetVersion) {
  console.error("No version found. Run via: bun version <newversion>");
  process.exit(1);
}

// Update root manifest.json
const rootManifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const { minAppVersion } = rootManifest;
rootManifest.version = targetVersion;
writeFileSync("manifest.json", JSON.stringify(rootManifest, null, "\t") + "\n");

// Update packages/obsidian/manifest.json
const pkgManifest = JSON.parse(
  readFileSync("packages/obsidian/manifest.json", "utf8")
);
pkgManifest.version = targetVersion;
writeFileSync(
  "packages/obsidian/manifest.json",
  JSON.stringify(pkgManifest, null, "\t") + "\n"
);

// Update versions.json
const versions = JSON.parse(readFileSync("versions.json", "utf8"));
versions[targetVersion] = minAppVersion;
writeFileSync("versions.json", JSON.stringify(versions, null, "\t") + "\n");

console.log(`Bumped to ${targetVersion} (minAppVersion: ${minAppVersion})`);
