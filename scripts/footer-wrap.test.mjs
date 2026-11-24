/**
 * A footer survives GitHub's wrapping (#261): the model of the wrapping, the
 * check on a description, and git-cliff's reading of wrapped lines, probed so
 * that a git-cliff that parses footers differently fails here first.
 *
 *   node --test scripts/footer-wrap.test.mjs
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { changelogFor } from "./changelog-for.mjs";
import { checkFooterWrap, startsFooter, unfinishedNotes, wrapLine } from "./footer-wrap.mjs";

// #253's footer, one line in its description.
const NOTE_253 =
	"Upgrade-Note: VaultOre now keeps one lock file per running note outside the vault, in `~/.config/vaultore/locks` (`%APPDATA%\\vaultore\\locks` on Windows), shared by the Obsidian plugin and the CLI: a note that is running in one is refused in the other, with a message naming who runs it. A run is also refused when its note changed between being read and the run starting; run it again. A runner must be able to create that directory: under a user with no home directory, as a container may run, every run is refused with a message saying so.";

// The same footer in #253's squash commit (dfa14c6's body), as GitHub wrapped it.
const WRAPPED_253 = [
	"Upgrade-Note: VaultOre now keeps one lock file per running note outside",
	"the vault, in `~/.config/vaultore/locks` (`%APPDATA%\\vaultore\\locks` on",
	"Windows), shared by the Obsidian plugin and the CLI: a note that is",
	"running in one is refused in the other, with a message naming who runs",
	"it. A run is also refused when its note changed between being read and",
	"the run starting; run it again. A runner must be able to create that",
	"directory: under a user with no home directory, as a container may run,",
	"every run is refused with a message saying so.",
];

const REWORDED_253 = NOTE_253.replace("create that directory: under", "create that directory. Under");

const description = (footer) =>
	["## What changed and why", "", "- The lock", "", "## Definition of done", "", "- [x] The gate above was actually run", "", footer].join("\n");

test("a line is wrapped as GitHub wraps it into a squash commit", () => {
	assert.deepEqual(wrapLine(NOTE_253), WRAPPED_253);
	assert.deepEqual(wrapLine("short"), ["short"]);
	// Code points, not UTF-16 units: an emoji counts once (#250's body).
	assert.deepEqual(wrapLine(`🔗 ${"x".repeat(69)}`), [`🔗 ${"x".repeat(69)}`]);
	// A word longer than the width keeps a line of its own.
	assert.deepEqual(wrapLine(`a ${"y".repeat(80)} b`), ["a", "y".repeat(80), "b"]);
});

test("#253's note fails, naming the word that would start a footer", () => {
	const result = checkFooterWrap(description(NOTE_253));
	assert.equal(result.ok, false);
	assert.match(result.message, /Upgrade-Note footer so that a line starts with 'directory:'/);
});

test("#253's note reworded passes", () => {
	assert.equal(checkFooterWrap(description(REWORDED_253)).ok, true);
});

test("a BREAKING CHANGE footer is checked the same way", () => {
	const footer = NOTE_253.replace("Upgrade-Note:", "BREAKING CHANGE:");
	assert.match(checkFooterWrap(description(footer)).message, /BREAKING CHANGE footer/);
});

test("a description without a footer passes, and so does a line the author broke", () => {
	assert.equal(checkFooterWrap(description("- [x] Fixes: a colon in the last item")).ok, true);
	assert.equal(checkFooterWrap("").ok, true);
	assert.equal(checkFooterWrap(description("Upgrade-Note: one thing.\nRefs: #12")).ok, true);
	assert.equal(checkFooterWrap(description(REWORDED_253).replaceAll("\n", "\r\n")).ok, true);
});

// Lines that follow the start of an Upgrade-Note, and whether git-cliff ends
// the note before them.
const PROBES = [
	["directory: under a user", true],
	["issue #171 decided it", true],
	["BREAKING CHANGE: x", true],
	["Closes #12 later", true],
	["under_score: y", true],
	["1st: y", true],
	["co-author: y", true],
	["Übergabe: y", true],
	["word:y", true],
	["a.b: y", true],
	["path/x: y", true],
	["`code`: y", true],
	["**bold**: y", true],
	["https://example.com x", true],
	["C:\\path x", true],
	["word #y", true],
	["e.g. x: y", false],
	["word : y", false],
	["two words: y", false],
	["#12 y", false],
	["word#12 y", false],
	["word  #12 y", false],
	["plain words, then: y", false],
];

test("the check agrees with git-cliff on which wrapped lines start a footer", (t) => {
	const { release } = changelogFor(
		t,
		PROBES.map(([line], i) => `fix: probe ${i} (#${i + 1})\n\nUpgrade-Note: probe ${i} starts here\n${line}`),
	);
	PROBES.forEach(([line, cuts], i) => {
		const entry = release.split("\n").find((l) => l.startsWith(`- Probe ${i} starts here`));
		assert.ok(entry, `probe ${i} has an entry`);
		assert.equal(entry === `- Probe ${i} starts here`, cuts, `git-cliff on '${line}'`);
		assert.equal(startsFooter(line), cuts, `the check on '${line}'`);
	});
});

test("end to end: the wrapped note is cut in the release notes, the reworded one is whole", (t) => {
	const squash = (footer) => `feat(core): the lock (#253)\n\n${description(footer).split("\n").flatMap((l) => wrapLine(l)).join("\n")}`;
	const { release } = changelogFor(t, [squash(NOTE_253), squash(REWORDED_253).replace("(#253)", "(#254)")]);
	const entries = release.split("\n").filter((l) => l.startsWith("- **core:** VaultOre now keeps"));
	assert.equal(entries.length, 2);
	assert.match(entries[0], /must be able to create that$/);
	assert.match(entries[1], /create that directory\. Under a user .* with a message saying so\.$/);
});

// The second defence (#261): a note that reached main cut off stops the
// release before it is committed or tagged.

const scripts = dirname(fileURLToPath(import.meta.url));

test("a release note that does not end a sentence is found; whole notes and subject links pass", () => {
	assert.deepEqual(
		unfinishedNotes([
			"### Breaking changes",
			"",
			"- **cli:** A breaking change without a footer ([#191](https://github.com/cronai-labs/vaultore/issues/191))",
			"- **obsidian:** Requires Obsidian 1.13.0 or later.",
			"",
			"### Upgrading",
			"",
			"- **core:** A runner must be able to create that",
			"- Read it with `vaultore schedules log`.",
			"- Rename the cell the error names (also in `depends`).",
			"",
			"### Features",
			"",
			"- **core:** Features need no full stop ([#1](https://x/1))",
			"- **core:** nor this",
		]),
		["- **core:** A runner must be able to create that"]
	);
});

test("end to end: #253's note, wrapped and not repaired, stops the release notes; reworded it passes", (t) => {
	// Another subject than #253's, so cliff.toml's repair for #253 does not apply.
	const squash = (footer) =>
		`feat(core): another lock (#300)\n\n${description(footer).split("\n").flatMap((l) => wrapLine(l)).join("\n")}`;
	const dir = mkdtempSync(join(tmpdir(), "vaultore-notes-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));

	const notes = (footer) => {
		const { changelog } = changelogFor(t, [squash(footer)]);
		const file = join(dir, "CHANGELOG.md");
		// git-cliff renders the release under test as 0.2.0, dated.
		writeFileSync(file, changelog);
		try {
			execFileSync("node", [join(scripts, "release-notes.mjs"), "0.2.0", file], { encoding: "utf8", stdio: "pipe" });
			return { ok: true, stderr: "" };
		} catch (err) {
			return { ok: false, stderr: String(err.stderr) };
		}
	};

	const cut = notes(NOTE_253);
	assert.equal(cut.ok, false);
	assert.match(cut.stderr, /do not end a sentence/);
	assert.match(cut.stderr, /must be able to create that\n/);
	assert.equal(notes(REWORDED_253).ok, true);
});
