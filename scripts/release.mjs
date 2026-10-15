/**
 * Step 1 of 2 of a release: prepares the release pull request.
 *
 *   bun run release              # version derived from conventional commits
 *   bun run release 0.4.0        # explicit version
 *   bun run release --dry-run    # show what would happen, change nothing
 *
 * main only changes through pull requests, so a release is a pull request
 * like any other. Run on an up-to-date main, this derives the next version
 * with git-cliff (see cliff.toml), creates branch release/<version>, syncs
 * every version location via version-bump.mjs, regenerates CHANGELOG.md and
 * commits "chore(release): <version>". Nothing is pushed and no tag is made;
 * it prints the commands that push the branch and open the pull request.
 *
 * Step 2, once that pull request is squash-merged: bun run release:tag
 * <version> (scripts/release-tag.mjs) tags the merged commit. Pushing the tag
 * runs .github/workflows/release.yml.
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

// The release branch must start from what is actually on origin/main, and the
// tag check below must see tags pushed from elsewhere.
console.log("Fetching origin...");
run("git", ["fetch", "--quiet", "--tags", "origin"]);
const local = git("rev-parse", "HEAD");
const remote = git("rev-parse", "origin/main");
if (local !== remote) {
	const behind = git("rev-list", "--count", `HEAD..origin/main`);
	const ahead = git("rev-list", "--count", `origin/main..HEAD`);
	fail(
		`main is ${behind} commit(s) behind and ${ahead} ahead of origin/main — the release must start from origin/main.\n` +
			`       Run: git pull --rebase origin main`
	);
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

const releaseBranch = `release/${version}`;
if (git("branch", "--list", releaseBranch) !== "") {
	fail(`branch ${releaseBranch} already exists locally`);
}
if (git("ls-remote", "--heads", "origin", releaseBranch) !== "") {
	fail(`branch ${releaseBranch} already exists on origin — is a release pull request already open?`);
}

if (dryRun) {
	console.log("\n--dry-run: stopping before any change. Changelog preview:\n");
	run("bunx", ["git-cliff", "--unreleased", "--tag", version]);
	process.exit(0);
}

// --- apply -----------------------------------------------------------------

console.log(`\nCreating branch ${releaseBranch}...`);
run("git", ["switch", "--quiet", "-c", releaseBranch]);

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

// release.yml publishes this version's CHANGELOG.md section as the release
// notes and refuses an empty one. Check it here, before anything is pushed:
// once the tag is pushed, fixing the changelog means a new version.
try {
	run("node", ["scripts/release-notes.mjs", version], { capture: true });
} catch (error) {
	fail(
		`CHANGELOG.md has no usable section for ${version}: ${String(error.stderr ?? error.message).trim()}\n` +
			`       Nothing is committed. You are on ${releaseBranch} with the bump uncommitted; inspect it before retrying.`
	);
}

console.log("\nCommitting...");
run("git", ["add", "-A"]);
run("git", ["commit", "--quiet", "-m", `chore(release): ${version}`]);

// The pull request title becomes the squash commit's subject, which is what
// release-tag.mjs looks for on main: "chore(release): <version> (#N)".
console.log(`
Prepared ${version} on ${releaseBranch}. Nothing is pushed. Review it, then open the release pull request:

  git show HEAD --stat
  git push -u origin ${releaseBranch}
  gh pr create --base main --head ${releaseBranch} --title "chore(release): ${version}" --body "Release ${version}. After this is squash-merged: bun run release:tag ${version}"

Once it is squash-merged into main:

  bun run release:tag ${version}

To undo before pushing:

  git switch main && git branch -D ${releaseBranch}
`);
