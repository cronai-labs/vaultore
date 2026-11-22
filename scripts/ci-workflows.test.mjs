/**
 * The two required checks (docs/decisions/ci-two-checks.md): the default
 * branch requires the check runs named `policy` and `code`, which are the jobs
 * of policy.yml and code.yml. A ruleset reads the latest check run of a name on
 * the head commit, and a skipped job reports success, so these hold the
 * workflows to what makes the two checks mean something: the names, the
 * triggers, no job that can be skipped, no filter that leaves a check pending.
 * The same test as cronai-labs/web-cronai-app's and web-cronai-de's, plus the
 * release gate, which reads the `code` check of the tagged commit.
 *
 *   node --test scripts/ci-workflows.test.mjs
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = join(ROOT, ".github", "workflows");
const files = readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f));
const read = (file) => readFileSync(join(DIR, file), "utf8");

/** The job ids of a workflow: the two-space keys under `jobs:`. */
function jobIds(text) {
	const at = text.search(/^jobs:\n/m);
	if (at < 0) return [];
	return [...text.slice(at).matchAll(/^ {2}([A-Za-z0-9_-]+):\s*$/gm)].map((m) => m[1] ?? "");
}

/** The lines of one job, from its key to the next job's. */
function jobBlock(text, id) {
	const start = text.indexOf(`\n  ${id}:\n`);
	if (start < 0) throw new Error(`no job ${id}`);
	const rest = text.slice(start + 1);
	const next = rest.slice(1).search(/^ {2}[A-Za-z0-9_-]+:\s*$/m);
	return next < 0 ? rest : rest.slice(0, next + 1);
}

/** The `on:` block, up to the next top-level key. */
function triggers(text) {
	const found = /^on:\n((?:(?: .*)?\n)*)/m.exec(text);
	if (found?.[1] === undefined) throw new Error("no on: block");
	return found[1];
}

const REQUIRED = {
	"policy.yml": "policy",
	"code.yml": "code",
};

describe("the required checks", () => {
	it("are one job each, named as the ruleset requires them", () => {
		for (const [file, id] of Object.entries(REQUIRED)) {
			assert.deepEqual(jobIds(read(file)), [id], file);
		}
	});

	it("are named by no job of another workflow", () => {
		// A second job of the same name would report a check run the ruleset
		// could read in its place.
		for (const file of files) {
			if (file in REQUIRED) continue;
			const ids = jobIds(read(file));
			for (const id of Object.values(REQUIRED)) {
				assert.ok(!ids.includes(id), `${file} has a job ${id}`);
			}
		}
	});

	it("have no job-level if:, so neither can report a skip as success", () => {
		for (const [file, id] of Object.entries(REQUIRED)) {
			assert.doesNotMatch(jobBlock(read(file), id), /^ {4}if:/m, file);
		}
	});

	it("have no path or branch filter on pull requests", () => {
		// A filtered-out workflow leaves its required check pending forever, and
		// layers of a stack target each other, not main.
		for (const file of Object.keys(REQUIRED)) {
			const on = triggers(read(file));
			assert.doesNotMatch(on, /paths(-ignore)?:/, file);
			const pr = /^ {2}pull_request:\n((?: {4}.*\n|\s*\n)*)/m.exec(on)?.[1];
			assert.ok(pr !== undefined, `${file} has no pull_request trigger`);
			assert.doesNotMatch(pr, /branches(-ignore)?:/, file);
		}
	});

	it("run on pushes to main and merge groups", () => {
		for (const file of Object.keys(REQUIRED)) {
			const on = triggers(read(file));
			assert.match(on, /^ {2}push:\n {4}branches: \[main\]/m, file);
			assert.match(on, /^ {2}merge_group:/m, file);
		}
	});
});

describe("policy.yml", () => {
	it("runs on every PR event that can change what it checks", () => {
		assert.ok(
			triggers(read("policy.yml")).includes(
				"types: [opened, synchronize, reopened, edited, ready_for_review]"
			)
		);
	});
});

describe("code.yml", () => {
	it("runs only when the head commit may have changed, never on an edit", () => {
		// An edit run would add a `code` check run to the head commit; if its job
		// were skipped, that success would stand in for the last real verdict.
		assert.match(triggers(read("code.yml")), /^ {4}types: \[opened, synchronize, reopened\]$/m);
	});
});

describe("the release gate", () => {
	it("reads the code check of code.yml", () => {
		// A release reads the evidence CI produced on the tagged commit. A name
		// left behind here refuses every release, or waits for a workflow that no
		// longer runs.
		const gate = readFileSync(join(ROOT, "scripts", "release-gate.sh"), "utf8");
		assert.match(gate, /^readonly REQUIRED_CHECK="code"$/m);
		assert.match(gate, /^readonly CI_WORKFLOW_PATH="\.github\/workflows\/code\.yml"$/m);
	});
});
