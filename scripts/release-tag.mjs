/**
 * Step 2 of 2 of a release: tags the squash-merged release commit.
 *
 *   bun run release:tag <version>
 *
 * Run after the pull request that `bun run release` prepared has been
 * squash-merged. Fetches origin, then refuses unless origin/main's tip is that
 * release commit: subject "chore(release): <version> (#N)", both manifests and
 * every package at <version>, versions.json mapping <version> to the
 * manifest's minAppVersion, and a usable CHANGELOG.md section. All of it is
 * read from the commit itself, not from the working tree. Then it creates an
 * annotated tag <version> on that commit. Nothing is pushed; it prints the
 * push command. Pushing the tag runs .github/workflows/release.yml, which
 * checks the commit is on main and passed ci-required before publishing.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SEMVER = /^\d+\.\d+\.\d+$/;
const releaseNotes = resolve(dirname(fileURLToPath(import.meta.url)), "release-notes.mjs");

function git(...args) {
	return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function fail(message) {
	console.error(`\nerror: ${message}`);
	process.exit(1);
}

const version = process.argv[2];
if (!version || !SEMVER.test(version)) {
	fail("usage: bun run release:tag <X.Y.Z>");
}

console.log("Fetching origin...");
git("fetch", "--quiet", "--tags", "origin");

if (git("tag", "--list", version) !== "") fail(`tag ${version} already exists`);
if (git("ls-remote", "--tags", "origin", `refs/tags/${version}`) !== "") {
	fail(`tag ${version} already exists on origin`);
}

const sha = git("rev-parse", "origin/main^{commit}");
const subject = git("log", "-1", "--format=%s", sha);
const expected = new RegExp(`^chore\\(release\\): ${version.replaceAll(".", "\\.")} \\(#\\d+\\)$`);
if (!expected.test(subject)) {
	fail(
		`origin/main's tip ${sha.slice(0, 12)} is not the merged release commit for ${version}.\n` +
			`       Its subject is '${subject}', expected 'chore(release): ${version} (#<pr>)'.\n` +
			`       Merge the release pull request first. If main has moved on since, tag by hand only after checking the commit.`
	);
}

const show = (path) => git("show", `${sha}:${path}`);
const json = (path) => JSON.parse(show(path));

const problems = [];
for (const path of [
	"manifest.json",
	"packages/obsidian/manifest.json",
	"package.json",
	"packages/core/package.json",
	"packages/obsidian/package.json",
	"packages/cli/package.json",
]) {
	const found = json(path).version;
	if (found !== version) problems.push(`${path} is at ${found}`);
}
const minAppVersion = json("manifest.json").minAppVersion;
const mapped = json("versions.json")[version];
if (mapped !== minAppVersion) {
	problems.push(`versions.json maps ${version} to ${mapped ?? "nothing"}, manifest.json's minAppVersion is ${minAppVersion}`);
}

// release.yml publishes this section as the release notes and fails without it.
const scratch = mkdtempSync(join(tmpdir(), "vaultore-release-tag-"));
try {
	const changelog = join(scratch, "CHANGELOG.md");
	writeFileSync(changelog, show("CHANGELOG.md"));
	execFileSync("node", [releaseNotes, version, changelog], { stdio: ["ignore", "ignore", "pipe"] });
} catch (error) {
	problems.push(`CHANGELOG.md: ${String(error.stderr ?? error.message).trim()}`);
} finally {
	rmSync(scratch, { recursive: true, force: true });
}

if (problems.length > 0) {
	fail(`the release commit ${sha.slice(0, 12)} is not consistent:\n       - ${problems.join("\n       - ")}`);
}

git("tag", "--annotate", version, "--message", version, sha);

console.log(`
Tagged ${version} (annotated) on ${sha}
  ${subject}

Push the tag to publish the release:

  git push origin ${version}

To undo before pushing:

  git tag -d ${version}
`);
