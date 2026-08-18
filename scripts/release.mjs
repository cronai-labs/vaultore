/**
 * One-command release.
 *
 *   bun run release              # version derived from conventional commits
 *   bun run release 0.4.0        # explicit version
 *   bun run release --dry-run    # show what would happen, change nothing
 *
 * Derives the next version with git-cliff (see cliff.toml), syncs every version
 * location via version-bump.mjs, regenerates CHANGELOG.md, then commits and
 * tags. Nothing is pushed — review the commit, then:
 *
 *   git push origin main <version>
 *
 * Pushing the tag runs .github/workflows/release.yml, which re-verifies the tag
 * against the manifests before publishing.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const SEMVER = /^\d+\.\d+\.\d+$/;

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const explicit = args.find((a) => !a.startsWith("--"));

function run(command, commandArgs, { capture = false } = {}) {
	return execFileSync(command, commandArgs, {
		encoding: "utf8",
		stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
	});
}

function git(...gitArgs) {
	return run("git", gitArgs, { capture: true }).trim();
}

function fail(message) {
	console.error(`\nerror: ${message}`);
	process.exit(1);
}

// --- preflight -------------------------------------------------------------

if (git("status", "--porcelain") !== "") {
	fail("working tree is not clean — commit or stash first");
}

const branch = git("rev-parse", "--abbrev-ref", "HEAD");
if (branch !== "main") {
	fail(`releases are cut from main, not '${branch}'`);
}

// --- version ---------------------------------------------------------------

let version;
if (explicit) {
	if (!SEMVER.test(explicit)) fail(`invalid semver: '${explicit}' (expected X.Y.Z)`);
	version = explicit;
	console.log(`Version ${version} (given explicitly)`);
} else {
	// git-cliff writes its warnings to stderr; only stdout is the version.
	version = run("bunx", ["git-cliff", "--bumped-version"], { capture: true }).trim();
	if (!SEMVER.test(version)) {
		fail(`git-cliff returned '${version}', which is not a semver triple`);
	}
	const hasTags = git("tag", "--list").trim() !== "";
	const previous = hasTags ? git("describe", "--tags", "--abbrev=0") : null;

	// git-cliff returns the current version unchanged when nothing since the
	// last tag warrants a bump — only docs/chore/ci/test commits.
	if (previous !== null && version === previous) {
		fail(
			`no releasable changes since ${previous} — every commit since then is a type that does not bump the version.\n` +
				`       Pass a version explicitly to release anyway: bun run release <version>`
		);
	}

	console.log(`Version ${version} (derived from commits since ${previous ?? "the first commit"})`);
}

const tags = git("tag", "--list").split("\n").filter(Boolean);
if (tags.includes(version)) fail(`tag ${version} already exists`);

if (dryRun) {
	console.log("\n--dry-run: stopping before any change. Changelog preview:\n");
	run("bunx", ["git-cliff", "--unreleased", "--tag", version]);
	process.exit(0);
}

// --- apply -----------------------------------------------------------------

console.log("\nSyncing version locations...");
run("node", ["version-bump.mjs", version]);

console.log("\nRegenerating CHANGELOG.md...");
run("bunx", ["git-cliff", "--tag", version, "--output", "CHANGELOG.md"]);

// version-bump.mjs is the authority on what a version bump touches; verify it
// actually landed rather than trusting it.
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
if (manifest.version !== version) {
	fail(`manifest.json is ${manifest.version} after the bump, expected ${version}`);
}

console.log("\nCommitting and tagging...");
run("git", ["add", "-A"]);
run("git", ["commit", "-m", `chore(release): ${version}`]);
run("git", ["tag", version]);

console.log(`
Released ${version} locally. Review it, then publish:

  git show HEAD --stat
  git push origin main ${version}

To undo before pushing:

  git tag -d ${version} && git reset --hard HEAD~1
`);
