/**
 * The address a release commit or tag will carry, checked before either is
 * made (#238). With GitHub's email privacy protection on, a push that carries
 * a private address is refused (GH007), and the refusal comes only at the
 * push, after the commit or the tag exists. So the release scripts ask git
 * which identity it is about to use and stop unless the address is a GitHub
 * no-reply address.
 *
 * `git var GIT_AUTHOR_IDENT` and `GIT_COMMITTER_IDENT` answer as `git commit`
 * and `git tag` will: they read GIT_AUTHOR_EMAIL, GIT_COMMITTER_EMAIL and
 * EMAIL from the environment, then user.email from the configuration. A tag's
 * tagger is the committer identity.
 */
import { execFileSync } from "node:child_process";

const NOREPLY = /^[^\s@<>]+@users\.noreply\.github\.com$/i;

/** The address in an identity line such as `Name <addr> 1700000000 +0100`. */
export function emailOfIdent(ident) {
	const found = /<([^<>]*)>/.exec(ident);
	return found ? found[1] : "";
}

/** Whether `email` is a GitHub no-reply address. */
export function isNoreplyAddress(email) {
	return NOREPLY.test(email);
}

/**
 * Problems with the identities `roles` will be written with, one line each;
 * empty when every one is a no-reply address. `roles` are names `git var`
 * knows: "GIT_AUTHOR_IDENT", "GIT_COMMITTER_IDENT".
 */
export function identityProblems(roles, { cwd, env = process.env } = {}) {
	const problems = [];
	for (const role of roles) {
		let ident;
		try {
			ident = execFileSync("git", ["var", role], {
				cwd,
				env,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			}).trim();
		} catch (err) {
			const detail = String(err.stderr ?? err.message ?? err).trim();
			problems.push(`${role}: git cannot tell which identity it would use (${detail})`);
			continue;
		}
		const email = emailOfIdent(ident);
		if (!isNoreplyAddress(email)) {
			problems.push(`${role}: '${email}' is not a users.noreply.github.com address`);
		}
	}
	return problems;
}

/** The message a release script stops with, naming the fix. */
export function identityRefusal(problems, command) {
	return (
		"the release would be written with an address GitHub refuses to publish:\n" +
		problems.map((p) => `       - ${p}\n`).join("") +
		"       Nothing was created. Pass the no-reply address for this command\n" +
		"       (GitHub, Settings, Emails, shows it as <id>+<login>@users.noreply.github.com):\n" +
		`         GIT_AUTHOR_EMAIL=<no-reply> GIT_COMMITTER_EMAIL=<no-reply> ${command}`
	);
}
