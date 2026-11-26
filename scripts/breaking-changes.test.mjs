/**
 * Breaking changes reach the release notes (#193): the policy check that asks
 * for a `BREAKING CHANGE:` footer, and the changelog section git-cliff renders
 * from it with this repository's cliff.toml. So does an `Upgrade-Note:` footer,
 * for a change that asks something of the user without being marked breaking.
 *
 *   node --test scripts/breaking-changes.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { checkBreakingFooter } from "./breaking-footer.mjs";
import { changelogFor } from "./changelog-for.mjs";

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

// GitHub wraps the description at 72 columns, so a longer footer spans lines;
// the entry is one line, as an Upgrade-Note's is (#288).
test("a breaking change's text is one line however GitHub wrapped it", (t) => {
	const { release } = changelogFor(t, [
		"fix(obsidian)!: scheduling stays on this computer (#285)\n\n" +
			"BREAKING CHANGE: The switch and the approvals now belong to your account\n" +
			"on each computer. Turn it on and approve your notes again.",
	]);

	assert.match(
		release,
		/### Breaking changes\n\n- \*\*obsidian:\*\* The switch and the approvals now belong to your account on each computer\. Turn it on and approve your notes again\.\n/,
	);
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
