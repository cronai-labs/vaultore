/**
 * Checks that the footer paragraph of a pull request description (an
 * `Upgrade-Note:` or `BREAKING CHANGE:`) survives GitHub's wrapping whole.
 *
 *   BODY=<pr description> node scripts/footer-wrap.mjs
 *
 * Exit status: 0 no footer, or none of its wrapped lines starts a footer;
 * 1 a wrapped line would start a new footer.
 *
 * The description becomes the squash commit's body, and GitHub wraps it: each
 * line on its own, greedily, at 72 characters (counted as code points), with
 * no indent on the lines it adds. Measured on 2026-11-23 against nine merged
 * pull requests of this repository, whose commit bodies this reproduces byte
 * for byte. When a line the wrapping starts happens to look like a footer,
 * git-cliff ends the note before it, and the release notes, which cannot be
 * corrected once published, carry half a sentence (#253, repaired in #262).
 */
import { pathToFileURL } from "node:url";

import { lastParagraph } from "./breaking-footer.mjs";

export const WRAP_WIDTH = 72;

// What git-cliff 2.14.2 reads as the start of a footer, probed with its
// parser: a first run of non-space characters that contains a colon
// (`directory:`, `a.b:`, `https://…`, `word:value`), `BREAKING CHANGE:`, or one word, one space
// and `#` (`issue #171`). `e.g. x: y`, `two words: y`, `#12` and
// `word  #12` stay part of the note. scripts/footer-wrap.test.mjs holds the
// probes and fails when git-cliff starts parsing differently.
const FOOTER_START = /^(?:BREAKING CHANGE:|[^\s:]*:|\S+ #)/;

const length = (text) => [...text].length;

/** Whether git-cliff reads this line of a commit's last paragraph as a new footer. */
export const startsFooter = (line) => FOOTER_START.test(line);

/** One line of a description as GitHub wraps it into a squash commit body. */
export function wrapLine(line, width = WRAP_WIDTH) {
	if (length(line) <= width) return [line];
	const lines = [];
	let current = null;
	for (const word of line.split(" ")) {
		if (current === null) current = word;
		else if (length(`${current} ${word}`) <= width) current += ` ${word}`;
		else {
			lines.push(current);
			current = word;
		}
	}
	lines.push(current);
	return lines;
}

export function checkFooterWrap(body) {
	const paragraph = lastParagraph(body);
	const first = paragraph.split("\n")[0];
	if (!FOOTER_START.test(first)) return { ok: true, message: "no footer" };
	const token = first.split(/:| #/)[0];

	for (const line of paragraph.split("\n")) {
		// Lines the author broke stay as they are; a line of their own that
		// starts a footer is one they meant. Only the wrapping adds surprises.
		for (const wrapped of wrapLine(line).slice(1)) {
			const start = FOOTER_START.exec(wrapped);
			if (start) {
				return {
					ok: false,
					message: `GitHub wraps the ${token} footer so that a line starts with '${start[0]}', which the release notes read as a new footer, cutting the note off before it. Reword or move that word, so that no line of the footer, wrapped at ${WRAP_WIDTH} characters, starts with a word containing a colon, or a word followed by ' #'. The line: '${wrapped}'`,
				};
			}
		}
	}
	return { ok: true, message: `the ${token} footer survives wrapping` };
}

// A breaking change without a footer shows its subject, which ends with the
// link git-cliff makes of "(#123)"; that is complete as it is.
const SUBJECT_LINK = /\(\[#\d+\]\([^)\s]*\)\)$/;
// The end of a sentence, before any closing quote, bracket or backtick.
const SENTENCE_END = /[.!?]["'`)\]]*$/;

/**
 * The second defence: the entries of a release's "Breaking changes" and
 * "Upgrading" sections (lines of the changelog section) that do not end a
 * sentence, as a note cut off by a wrapped footer line does. By then the
 * commit is on main, so the fix is a `cliff.toml` preprocessor (#262), made
 * before the release is committed and tagged.
 */
export function unfinishedNotes(lines) {
	const found = [];
	let checked = false;
	for (const line of lines) {
		if (line.startsWith("### ")) {
			checked = line === "### Breaking changes" || line === "### Upgrading";
			continue;
		}
		if (!checked || !/^[-*] /.test(line)) continue;
		const entry = line.trimEnd();
		if (!SENTENCE_END.test(entry) && !SUBJECT_LINK.test(entry)) found.push(entry);
	}
	return found;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const result = checkFooterWrap(process.env.BODY ?? "");
	if (!result.ok) {
		console.error(`::error::${result.message}`);
		process.exit(1);
	}
	console.log(`ok: ${result.message}`);
}
