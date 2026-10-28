/**
 * Checks that a pull request marked as breaking ("!" in its title) ends its
 * description with a `BREAKING CHANGE:` footer.
 *
 *   TITLE=<pr title> BODY=<pr description> node scripts/breaking-footer.mjs
 *
 * Exit status: 0 not breaking, or the footer is there; 1 the footer is missing.
 *
 * The description becomes the squash commit's body, and git-cliff puts the
 * footer's text under "Breaking changes" in the release notes (#193). A footer
 * only counts as the last paragraph, which in the PR template comes after the
 * Definition of done.
 */
import { pathToFileURL } from "node:url";

const BREAKING_TITLE = /^[a-z]+(\([a-z0-9._/-]+\))?!: /;
const FOOTER = /^BREAKING[ -]CHANGE: \S/;

export function lastParagraph(body) {
	const paragraphs = body
		.replace(/\r\n?/g, "\n")
		.split(/\n[ \t]*\n/)
		.map((paragraph) => paragraph.trim())
		.filter(Boolean);
	return paragraphs.at(-1) ?? "";
}

export function checkBreakingFooter(title, body) {
	if (!BREAKING_TITLE.test(title)) {
		return { ok: true, message: "not a breaking change" };
	}
	const last = lastParagraph(body);
	if (FOOTER.test(last)) {
		return { ok: true, message: last.split("\n")[0] };
	}
	return {
		ok: false,
		message:
			"A breaking change ('!' in the title) needs 'BREAKING CHANGE: <what breaks and what to do>' as the last paragraph of the description, after the Definition of done.",
	};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const result = checkBreakingFooter(process.env.TITLE ?? "", process.env.BODY ?? "");
	if (!result.ok) {
		console.error(`::error::${result.message}`);
		process.exit(1);
	}
	console.log(`ok: ${result.message}`);
}
