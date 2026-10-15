/**
 * Prints the release notes for one version: its section of CHANGELOG.md,
 * without the heading.
 *
 *   node scripts/release-notes.mjs <version> [changelog]
 *
 * Exit status: 0 printed, 1 no usable section, 2 usage.
 *
 * release.yml publishes this as the GitHub release body. release.mjs runs it
 * before committing the release, and release-tag.mjs before tagging, so an
 * unusable section stops the release while the version is unspent. The curated changelog is the point of the release tooling;
 * GitHub's generated notes list merged pull requests instead, Dependabot ones
 * included, and drop any commit whose pull request GitHub can no longer find.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SEMVER = /^\d+\.\d+\.\d+$/;

function die(message, code = 1) {
	console.error(`release-notes: ${message}`);
	process.exit(code);
}

const [version, changelogArg] = process.argv.slice(2);
if (!version || !SEMVER.test(version)) {
	die("usage: release-notes.mjs <X.Y.Z> [changelog]", 2);
}

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const changelog = changelogArg ?? resolve(rootDir, "CHANGELOG.md");

let text;
try {
	text = readFileSync(changelog, "utf8");
} catch {
	die(`no changelog at ${changelog}`, 2);
}

// cliff.toml renders a released section as "## [X.Y.Z] - YYYY-MM-DD".
// "## [Unreleased]" and undated headings are not releases and never match.
// A fixed pattern and a string comparison, so the version is never compiled
// into a regular expression (CodeQL js/regex-injection).
const HEADING = /^## \[([^\]]+)\] - \d{4}-\d{2}-\d{2}$/;

const lines = text.split("\n");
const start = lines.findIndex((line) => HEADING.exec(line)?.[1] === version);
if (start === -1) die(`CHANGELOG.md has no dated section for ${version}`);

let end = lines.findIndex((line, i) => i > start && line.startsWith("## "));
if (end === -1) end = lines.length;

const section = lines.slice(start + 1, end);
while (section.length > 0 && section[0].trim() === "") section.shift();
while (section.length > 0 && section.at(-1).trim() === "") section.pop();

// A wrong extraction (a heading that matched an empty section, or a section
// whose commits were all filtered out by cliff.toml) has no entries at all.
// Both bullet styles count, so a template change cannot zero this guard.
const entries = section.filter((line) => /^[-*] /.test(line)).length;
if (entries === 0) die(`the ${version} section has no entries`);

process.stdout.write(`${section.join("\n")}\n`);
