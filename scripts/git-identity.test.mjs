/**
 * The release scripts refuse to write a commit or tag with an address GitHub
 * would refuse to publish (#238). The check asks git itself, in a scratch
 * repository, with the environment a release would run with.
 *
 *   node --test scripts/git-identity.test.mjs
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import {
	emailOfIdent,
	identityProblems,
	identityRefusal,
	isNoreplyAddress,
} from "./git-identity.mjs";

const NOREPLY = "12345+someone@users.noreply.github.com";
const PRIVATE = "someone@example.org";

const repo = mkdtempSync(join(tmpdir(), "vaultore-identity-"));
after(() => rmSync(repo, { recursive: true, force: true }));
execFileSync("git", ["init", "--quiet", repo]);
execFileSync("git", ["-C", repo, "config", "user.name", "Someone"]);
execFileSync("git", ["-C", repo, "config", "user.email", PRIVATE]);

/** The environment of a release run: no ambient git identity, then `extra`. */
function envWith(extra = {}) {
	const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: repo };
	for (const key of [
		"GIT_AUTHOR_EMAIL",
		"GIT_COMMITTER_EMAIL",
		"GIT_AUTHOR_NAME",
		"GIT_COMMITTER_NAME",
		"EMAIL",
		"GIT_CONFIG_GLOBAL",
	]) {
		delete env[key];
	}
	return { ...env, ...extra };
}

const BOTH = ["GIT_AUTHOR_IDENT", "GIT_COMMITTER_IDENT"];

describe("the address check", () => {
	it("reads the address out of an identity line", () => {
		assert.equal(emailOfIdent(`Someone <${NOREPLY}> 1700000000 +0100`), NOREPLY);
		assert.equal(emailOfIdent("no address here"), "");
	});

	it("accepts only a users.noreply.github.com address", () => {
		assert.ok(isNoreplyAddress(NOREPLY));
		assert.ok(isNoreplyAddress("someone@users.noreply.github.com"));
		assert.ok(!isNoreplyAddress(PRIVATE));
		assert.ok(!isNoreplyAddress("someone@users.noreply.github.com.example.org"));
		assert.ok(!isNoreplyAddress(""));
	});

	it("refuses the configured private address for the commit and the tag", () => {
		const problems = identityProblems(BOTH, { cwd: repo, env: envWith() });
		assert.equal(problems.length, 2);
		assert.match(problems[0], /GIT_AUTHOR_IDENT: 'someone@example\.org'/);
		assert.match(problems[1], /GIT_COMMITTER_IDENT: 'someone@example\.org'/);
	});

	it("passes when both addresses are given for the command", () => {
		const env = envWith({ GIT_AUTHOR_EMAIL: NOREPLY, GIT_COMMITTER_EMAIL: NOREPLY });
		assert.deepEqual(identityProblems(BOTH, { cwd: repo, env }), []);
	});

	it("still refuses when only the author address is given", () => {
		// The case of 0.3.0's tag: the tagger is the committer.
		const env = envWith({ GIT_AUTHOR_EMAIL: NOREPLY });
		const problems = identityProblems(BOTH, { cwd: repo, env });
		assert.equal(problems.length, 1);
		assert.match(problems[0], /^GIT_COMMITTER_IDENT:/);
	});

	it("names the fix and says nothing was created", () => {
		const message = identityRefusal(["GIT_COMMITTER_IDENT: 'x' is not …"], "bun run release:tag 1.2.3");
		assert.match(message, /Nothing was created/);
		assert.match(message, /GIT_AUTHOR_EMAIL=<no-reply> GIT_COMMITTER_EMAIL=<no-reply> bun run release:tag 1\.2\.3/);
	});
});
