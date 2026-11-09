/**
 * Breaking changes reach the release notes (#193): the policy check that asks
 * for a `BREAKING CHANGE:` footer, and the changelog section git-cliff renders
 * from it with this repository's cliff.toml. So does an `Upgrade-Note:` footer,
 * for a change that asks something of the user without being marked breaking.
 *
 *   node --test scripts/breaking-changes.test.mjs
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { checkBreakingFooter } from "./breaking-footer.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Shaped like a squash commit here: the PR description, ending with the
// Definition of done, then the footer.
const BODY_WITH_FOOTER = [
	"## What changed and why",
	"",
	"- `minAppVersion` 1.11.4 → 1.13.0",
	"",
	"## Definition of done",
	"",
	"- [x] Task boxes ticked in the linked issue",
	"- [x] The gate above was actually run",
	"",
	"BREAKING CHANGE: Requires Obsidian 1.13.0 or later.",
].join("\n");

test("a title without '!' needs no footer", () => {
	assert.equal(checkBreakingFooter("fix(core): a fix", "No footer.").ok, true);
});

test("a breaking title passes with the footer as the last paragraph", () => {
	const result = checkBreakingFooter("feat(obsidian)!: settings search", BODY_WITH_FOOTER);
	assert.equal(result.ok, true);
	assert.equal(result.message, "BREAKING CHANGE: Requires Obsidian 1.13.0 or later.");
});

test("a breaking title passes with Windows line endings, as the web editor saves them", () => {
	const body = `${BODY_WITH_FOOTER.replaceAll("\n", "\r\n")}\r\n`;
	assert.equal(checkBreakingFooter("feat!: settings search", body).ok, true);
});

test("a breaking title fails without the footer", () => {
	const body = BODY_WITH_FOOTER.split("\n").slice(0, -2).join("\n");
	assert.equal(checkBreakingFooter("feat(obsidian)!: settings search", body).ok, false);
});

test("a breaking title fails when the footer is not the last paragraph", () => {
	const body = `${BODY_WITH_FOOTER}\n\nOne more paragraph.`;
	assert.equal(checkBreakingFooter("feat(obsidian)!: settings search", body).ok, false);
});

/**
 * The changelog this repository's cliff.toml renders for a throwaway repository:
 * one release 0.1.0, then `messages` as the commits of 0.2.0.
 */
function changelogFor(t, messages) {
	const repo = mkdtempSync(join(tmpdir(), "vaultore-cliff-"));
	t.after(() => rmSync(repo, { recursive: true, force: true }));
	const git = (...args) =>
		execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], {
			cwd: repo,
			stdio: "pipe",
		});
	git("init", "-q");
	git("commit", "-q", "--allow-empty", "-m", "fix(core): before the release");
	git("tag", "0.1.0");
	for (const message of messages) git("commit", "-q", "--allow-empty", "-m", message);

	const changelog = execFileSync(
		join(root, "node_modules", ".bin", "git-cliff"),
		["--config", join(root, "cliff.toml"), "--repository", repo, "--tag", "0.2.0"],
		{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
	);
	return {
		changelog,
		release: changelog.slice(changelog.indexOf("## [0.2.0]"), changelog.indexOf("## [0.1.0]")),
		earlier: changelog.slice(changelog.indexOf("## [0.1.0]")),
	};
}

test("the changelog lists breaking changes first, with the footer's text", (t) => {
	const { release, earlier } = changelogFor(t, [
		`feat(obsidian)!: settings search (#190)\n\n${BODY_WITH_FOOTER}`,
		"feat(cli)!: a breaking change without a footer (#191)",
		"fix(core): a plain fix (#192)",
	]);

	assert.match(
		release,
		/### Breaking changes\n\n- \*\*obsidian:\*\* Requires Obsidian 1\.13\.0 or later\.\n- \*\*cli:\*\* A breaking change without a footer \(\[#191\]/,
	);
	assert.ok(release.indexOf("### Breaking changes") < release.indexOf("### Features"));
	assert.match(release, /### Features\n\n- \*\*obsidian:\*\* Settings search \(\[#190\]/);
	assert.doesNotMatch(release, /### Upgrading/);
	assert.doesNotMatch(earlier, /Breaking changes/);
});

// A squash commit as GitHub writes it: the description wrapped at 72 columns,
// so the footer spans lines, and list items above it that begin with "- #".
const BODY_WITH_UPGRADE_NOTE = [
	"## Known follow-ups",
	"",
	"- #211: parsing is quadratic in the number of cells",
	"",
	"## Definition of done",
	"",
	"- [x] The gate above was actually run",
	"",
	"Upgrade-Note: a note whose `timeout` is not a number is refused. Correct",
	"the value the error names.",
].join("\n");

test("the changelog has an Upgrading section from Upgrade-Note footers, after the breaking changes", (t) => {
	const { release, earlier } = changelogFor(t, [
		`feat(obsidian)!: settings search (#190)\n\n${BODY_WITH_FOOTER}`,
		`fix(parser): refuse a timeout that is not a number (#214)\n\n${BODY_WITH_UPGRADE_NOTE}`,
		"feat: the agent asks first (#220)\n\nUpgrade-Note: Approve each scheduled note once.",
		"fix(core): a plain fix (#192)",
	]);

	assert.match(
		release,
		/### Upgrading\n\n- \*\*parser:\*\* A note whose `timeout` is not a number is refused\. Correct the value the error names\.\n- Approve each scheduled note once\.\n\n### /,
	);
	assert.ok(release.indexOf("### Breaking changes") < release.indexOf("### Upgrading"));
	assert.ok(release.indexOf("### Upgrading") < release.indexOf("### Features"));
	// The commit keeps its own line in its section, and the note is not a section of its own.
	assert.match(release, /### Bug Fixes\n\n- \*\*parser:\*\* Refuse a timeout that is not a number \(\[#214\]/);
	assert.doesNotMatch(release, /Upgrade-Note/);
	assert.doesNotMatch(earlier, /Upgrading/);
});
