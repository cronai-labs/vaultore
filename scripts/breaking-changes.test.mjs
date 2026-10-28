/**
 * Breaking changes reach the release notes (#193): the policy check that asks
 * for a `BREAKING CHANGE:` footer, and the changelog section git-cliff renders
 * from it with this repository's cliff.toml.
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

test("the changelog lists breaking changes first, with the footer's text", (t) => {
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
	git("commit", "-q", "--allow-empty", "-m", `feat(obsidian)!: settings search (#190)\n\n${BODY_WITH_FOOTER}`);
	git("commit", "-q", "--allow-empty", "-m", "feat(cli)!: a breaking change without a footer (#191)");
	git("commit", "-q", "--allow-empty", "-m", "fix(core): a plain fix (#192)");

	const changelog = execFileSync(
		join(root, "node_modules", ".bin", "git-cliff"),
		["--config", join(root, "cliff.toml"), "--repository", repo, "--tag", "0.2.0"],
		{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
	);
	const release = changelog.slice(changelog.indexOf("## [0.2.0]"), changelog.indexOf("## [0.1.0]"));

	assert.match(
		release,
		/### Breaking changes\n\n- \*\*obsidian:\*\* Requires Obsidian 1\.13\.0 or later\.\n- \*\*cli:\*\* A breaking change without a footer \(\[#191\]/,
	);
	assert.ok(release.indexOf("### Breaking changes") < release.indexOf("### Features"));
	assert.match(release, /### Features\n\n- \*\*obsidian:\*\* Settings search \(\[#190\]/);
	assert.doesNotMatch(changelog.slice(changelog.indexOf("## [0.1.0]")), /Breaking changes/);
});
