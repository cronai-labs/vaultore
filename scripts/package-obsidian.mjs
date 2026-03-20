import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(scriptDir, "..");
const obsidianDir = resolve(rootDir, "packages/obsidian");
const distDir = resolve(obsidianDir, "dist");
const outDir = resolve(obsidianDir, "package/vaultore");

const artifacts = [
  { src: "dist/main.js", dest: "main.js" },
  { src: "manifest.json", dest: "manifest.json" },
  { src: "styles.css", dest: "styles.css" },
];

function copyFile(src, dest) {
  const absoluteSrc = resolve(obsidianDir, src);
  if (!existsSync(absoluteSrc)) {
    throw new Error(`Missing artifact: ${src}`);
  }
  const absoluteDest = resolve(outDir, dest);
  mkdirSync(dirname(absoluteDest), { recursive: true });
  cpSync(absoluteSrc, absoluteDest);
}

function copyDir(src, dest) {
  const absoluteSrc = resolve(obsidianDir, src);
  if (!existsSync(absoluteSrc)) return false;
  const absoluteDest = resolve(outDir, dest);
  mkdirSync(dirname(absoluteDest), { recursive: true });
  cpSync(absoluteSrc, absoluteDest, { recursive: true });
  return true;
}

if (!existsSync(distDir)) {
  execSync("bun run build", { cwd: obsidianDir, stdio: "inherit" });
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

for (const artifact of artifacts) {
  copyFile(artifact.src, artifact.dest);
}

console.log(`VaultOre plugin packaged at ${outDir}`);
